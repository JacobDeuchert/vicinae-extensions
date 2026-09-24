import path from "path";
import { readFile, writeFile } from "fs";
import { promisify } from "util";
import { DatabaseRow } from "../types";
import initSqlJs, { Database } from "sql.js";
import { getVSCodeStateDBPath } from "../helpers";
import { RECENT_PROJECTS_QUERY, SQL_WASM_PATH } from "../constants";

const read = promisify(readFile);
const write = promisify(writeFile);

let DATABASE: Database | null = null;

function getUint32(buffer: Uint8Array, offset: number): number {
    return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(offset, false);
}

function applyWalFrames(database: Uint8Array, wal: Uint8Array): Uint8Array {
    if (wal.byteLength < 32) {
        return database;
    }

    const magic = getUint32(wal, 0);
    if (magic !== 0x377f0682 && magic !== 0x377f0683) {
        return database;
    }

    const pageSize = getUint32(wal, 8);
    const frameSize = pageSize + 24;
    if (pageSize === 0 || frameSize <= 24) {
        return database;
    }

    const walSalt1 = getUint32(wal, 16);
    const walSalt2 = getUint32(wal, 20);
    let snapshot = database;
    let pendingFrames: Array<{ pageNumber: number; page: Uint8Array }> = [];

    for (let offset = 32; offset + frameSize <= wal.byteLength; offset += frameSize) {
        const pageNumber = getUint32(wal, offset);
        const databaseSize = getUint32(wal, offset + 4);
        const frameSalt1 = getUint32(wal, offset + 8);
        const frameSalt2 = getUint32(wal, offset + 12);

        if (pageNumber === 0 || frameSalt1 !== walSalt1 || frameSalt2 !== walSalt2) {
            break;
        }

        pendingFrames.push({
            pageNumber,
            page: wal.slice(offset + 24, offset + frameSize),
        });

        // A non-zero database size marks the last frame of a committed transaction.
        if (databaseSize === 0) {
            continue;
        }

        const nextSnapshot = new Uint8Array(databaseSize * pageSize);
        nextSnapshot.set(snapshot.subarray(0, Math.min(snapshot.length, nextSnapshot.length)));

        for (const frame of pendingFrames) {
            const pageOffset = (frame.pageNumber - 1) * pageSize;
            if (pageOffset < nextSnapshot.length) {
                nextSnapshot.set(frame.page.subarray(0, Math.min(pageSize, nextSnapshot.length - pageOffset)), pageOffset);
            }
        }

        snapshot = nextSnapshot;
        pendingFrames = [];
    }

    return snapshot;
}

async function readDatabaseSnapshot(dbPath: string): Promise<Uint8Array> {
    const database = await read(dbPath);

    try {
        const wal = await read(`${dbPath}-wal`);
        return applyWalFrames(new Uint8Array(database), new Uint8Array(wal));
    } catch (error) {
        if ((error as { code?: string }).code !== "ENOENT") {
            throw error;
        }
        return new Uint8Array(database);
    }
}

export async function initializeDatabase(): Promise<Database> {
    if (DATABASE) {
        return DATABASE;
    }

    const dbPath = getVSCodeStateDBPath();

    try {
        const bufferRaw = await readDatabaseSnapshot(dbPath);
        const SQL = await initSqlJs({
            locateFile: () => path.resolve(__dirname, SQL_WASM_PATH),
        });

        console.log("[DEBUG] Loaded VSCode state database from:", dbPath);
        DATABASE = new SQL.Database(bufferRaw);
        return DATABASE;
    } catch (error) {
        throw new Error(`Failed to initialize database: ${(error as Error).message}`);
    }
}

export function getDatabase(): Database {
    if (!DATABASE) {
        throw new Error("Database not initialized. Call initializeDatabase() first.");
    }
    return DATABASE;
}

export function queryRecentProjects(): DatabaseRow[] {
    const db = getDatabase();
    const results: DatabaseRow[] = [];

    try {
        const statement = db.prepare(RECENT_PROJECTS_QUERY);

        while (statement.step()) {
            const row = statement.getAsObject();
            if (row.value) {
                results.push({
                    key: row.key as string,
                    value: row.value as string,
                });
            }
        }

        statement.free();
        return results;
    } catch (error) {
        console.error("Failed to query the database", error);
        throw new Error("Failed to query the database");
    }
}

export function closeDatabase(): void {
    if (DATABASE) {
        DATABASE.close();
        DATABASE = null;
    }
}

export async function removeRecentProject(projectPath: string): Promise<void> {
    const db = getDatabase();
    const dbPath = getVSCodeStateDBPath();

    try {
        let key: string = "";
        let recentData: any = null;
        const statement = db.prepare(RECENT_PROJECTS_QUERY);

        while (statement.step()) {
            const row = statement.getAsObject();
            if (row.value) {
                key = row.key as string;
                recentData = JSON.parse(row.value as string);
                break;
            }
        }
        statement.free();

        if (!recentData || !recentData.entries) {
            throw new Error("No recent projects data found");
        }

        // Filter out the project to remove
        const originalLength = recentData.entries.length;
        recentData.entries = recentData.entries.filter((entry: any) => {
            const entryPath = entry.folderUri || entry.workspace?.configPath || entry.fileUri || "";
            const decodedPath = decodeURIComponent(entryPath.replace(/^file:\/\//, ""));
            return decodedPath !== projectPath;
        });

        // Check if anything was removed
        if (recentData.entries.length === originalLength) {
            console.warn("Project not found in recent list:", projectPath);
            return;
        }

        const updatedValue = JSON.stringify(recentData);
        db.run("UPDATE ItemTable SET value = ? WHERE key = ?", [updatedValue, key]);

        const data = db.export();
        await write(dbPath, data);

        console.log("[DEBUG] Removed project from recents:", projectPath);
    } catch (error) {
        console.error("Failed to remove project from recents:", error);
        throw new Error(`Failed to remove project: ${(error as Error).message}`);
    }
}
