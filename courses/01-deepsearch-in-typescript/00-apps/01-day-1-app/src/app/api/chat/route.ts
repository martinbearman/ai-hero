import type { Message } from "ai";
import { streamText, createDataStreamResponse, appendResponseMessages } from "ai";
import { z } from "zod";
import { model } from "~/models.ts";
import { auth } from "~/server/auth";
import { searchSerper } from "~/serper";
import { canMakeRequest, createUserRequest, upsertChat } from "~/server/db/queries";

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

  // Check rate limit
  const canProceed = await canMakeRequest(session.user.id);
  if (!canProceed) {
    return new Response("Too Many Requests - Daily limit exceeded", { status: 429 });
  }

  const body = (await request.json()) as {
    messages: Array<Message>;
    chatId?: string;
  };

  // Record the request
  await createUserRequest(session.user.id);

  // Extract messages and chatId from body
  const { messages, chatId } = body;

  // Create a new chat ID if one wasn't provided
  const currentChatId = chatId ?? crypto.randomUUID();

  // Save the initial chat with just the user's message
  // This ensures we have a record even if the stream fails
  await upsertChat({
    userId: session.user.id,
    chatId: currentChatId,
    title: messages[messages.length - 1]?.content ?? "New Chat",
    messages,
  });

  return createDataStreamResponse({
    execute: async (dataStream) => {
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
        onFinish: async (result) => {
          // Get the response messages
          const responseMessages = result.response.messages;

          // Merge the existing messages with the response messages
          const updatedMessages = appendResponseMessages({
            messages,
            responseMessages,
          });

          // Save the complete chat with all messages
          await upsertChat({
            userId: session.user.id,
            chatId: currentChatId,
            title: messages[0]?.content ?? "New Chat",
            messages: updatedMessages,
          });
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