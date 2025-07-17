import type { Message } from "ai";
import { streamText, createDataStreamResponse } from "ai";
import { z } from "zod";
import { model } from "~/models.ts";
import { auth } from "~/server/auth";
import { searchSerper } from "~/serper";

export const maxDuration = 60;

const SYSTEM_PROMPT = `You are a helpful AI assistant with the ability to search the web for real-time information.

When answering questions:
- ALWAYS search the web first to get the most up-to-date information
- NEVER show raw URLs in your responses. Instead, ALWAYS use markdown links in this format: [descriptive title](url)
  For example:
  ❌ Read more at https://example.com
  ✅ Read more in the [comprehensive guide](https://example.com)
- When citing sources, make the link text descriptive of the source:
  ❌ According to [this](https://example.com)...
  ✅ According to [The New York Times](https://example.com)...
- Synthesize information from multiple sources when possible
- Be concise but thorough in your responses
- If you're unsure about something, acknowledge the uncertainty and explain what you do know
- Format your responses in markdown for better readability

Remember to:
1. Search before answering any factual questions
2. Include multiple sources when available
3. NEVER show raw URLs - always wrap them in markdown links with descriptive titles
4. Be transparent about the recency and reliability of your sources`;

export async function POST(request: Request) {
  // Check if user is authenticated
  const session = await auth();
  if (!session?.user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = (await request.json()) as {
    messages: Array<Message>;
  };

  return createDataStreamResponse({
    execute: async (dataStream) => {
      const { messages } = body;

      const result = streamText({
        model,
        messages,
        maxSteps: 10,
        system: SYSTEM_PROMPT,
        tools: {
          searchWeb: {
            parameters: z.object({
              query: z.string().describe("The query to search the web for"),
            }),
            execute: async ({ query }, { abortSignal }) => {
              const results = await searchSerper(
                { q: query, num: 10 },
                abortSignal,
              );

              return results.organic.map((result) => ({
                title: result.title,
                link: result.link,
                snippet: result.snippet,
              }));
            },
          },
        },
      });

      result.mergeIntoDataStream(dataStream);
    },
    onError: (e) => {
      console.error(e);
      return "Oops, an error occurred!";
    },
  });
} 