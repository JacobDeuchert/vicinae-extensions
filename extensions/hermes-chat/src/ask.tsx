import {
  Action,
  ActionPanel,
  List,
  getPreferenceValues,
  showToast,
  Toast,
} from "@vicinae/api";
import { useEffect, useRef, useState } from "react";

type ChatCompletionResponse = {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
};

type Exchange = {
  id: number;
  question: string;
  reply?: string;
  error?: string;
};

async function askHermes(message: string): Promise<string> {
  const { baseUrl, apiToken, model } = getPreferenceValues<Preferences.Ask>();
  const url = `${(baseUrl ?? "http://127.0.0.1:8642/v1").replace(/\/+$/, "")}/chat/completions`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiToken) headers["Authorization"] = `Bearer ${apiToken}`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: model || "hermes",
      messages: [{ role: "user", content: message }],
      stream: false,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as ChatCompletionResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(data.error?.message ?? "Empty response from Hermes");
  }
  return content;
}

function exchangeMarkdown(e: Exchange): string {
  const header = `**You:** ${e.question}\n\n---\n\n`;
  if (e.error) return `${header}## Request failed\n\n\`\`\`\n${e.error}\n\`\`\``;
  if (e.reply === undefined) return `${header}*Waiting for Hermes…*`;
  return header + e.reply;
}

export default function Ask(props: { arguments: Arguments.Ask }) {
  const [searchText, setSearchText] = useState("");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const nextId = useRef(0);

  const send = (question: string) => {
    const id = nextId.current++;
    setExchanges((prev) => [{ id, question }, ...prev]);

    askHermes(question)
      .then((reply) => {
        setExchanges((prev) => prev.map((e) => (e.id === id ? { ...e, reply } : e)));
      })
      .catch((err: Error) => {
        setExchanges((prev) => prev.map((e) => (e.id === id ? { ...e, error: err.message } : e)));
        showToast({ style: Toast.Style.Failure, title: "Hermes request failed", message: err.message });
      });
  };

  const submit = () => {
    const question = searchText.trim();
    if (!question) return;
    setSearchText("");
    send(question);
  };

  useEffect(() => {
    const initial = props.arguments.message?.trim();
    if (initial) send(initial);
  }, []);

  return (
    <List
      isShowingDetail={exchanges.length > 0}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      filtering={false}
      searchBarPlaceholder="Message Hermes…"
      actions={
        <ActionPanel>
          <Action title="Send" onAction={submit} />
        </ActionPanel>
      }
    >
      {exchanges.length === 0 ? (
        <List.EmptyView
          title="Message Hermes"
          description="Type a message and press Enter to send"
        />
      ) : (
        exchanges.map((e) => (
          <List.Item
            key={e.id}
            title={e.question}
            subtitle={e.error ? "failed" : e.reply === undefined ? "…" : undefined}
            detail={<List.Item.Detail markdown={exchangeMarkdown(e)} />}
            actions={
              <ActionPanel>
                <Action title="Send" onAction={submit} />
                {e.reply && <Action.CopyToClipboard title="Copy Reply" content={e.reply} />}
                <Action.CopyToClipboard title="Copy Message" content={e.question} />
              </ActionPanel>
            }
          />
        ))
      )}
    </List>
  );
}
