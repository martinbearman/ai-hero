import type { Message } from "ai";
import { createDataStreamResponse, appendResponseMessages } from "ai";
import { model } from "~/models.ts";
import { auth } from "~/server/auth";
import { canMakeRequest, upsertChat } from "~/server/db/queries";
import { Langfuse } from "langfuse";
import { env } from "~/env";
import { streamFromDeepSearch } from "~/deep-search";

const langfuse = new Langfuse({
  environment: env.NODE_ENV,
});

export const maxDuration = 60;

export async function POST(request: Request) {
  // Check if user is authenticated
  const session = await auth();
  if (!session?.user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = (await request.json()) as {
    messages: Array<Message>;
    chatId: string;
    isNewChat: boolean;
  };

  // Extract messages, chatId, and isNewChat from body
  const { messages, chatId, isNewChat } = body;

  // Create a trace before any database operations
  const trace = langfuse.trace({
    name: "chat",
    userId: session.user.id,
  });

  // Check rate limit with span
  const rateLimitSpan = trace.span({
    name: "check-rate-limit",
    input: {
      userId: session.user.id,
    },
  });
  const canProceed = await canMakeRequest(session.user.id);
  rateLimitSpan.end({
    output: {
      canProceed,
    },
  });

  if (!canProceed) {
    return new Response("Too Many Requests - Daily limit exceeded", { status: 429 });
  }

  // Save the initial chat with just the user's message
  // This ensures we have a record even if the stream fails
  const initialChatSpan = trace.span({
    name: "save-initial-chat",
    input: {
      userId: session.user.id,
      chatId,
      title: messages[0]?.content ?? "New Chat",
      messageCount: messages.length,
    },
  });

  try {
    await upsertChat({
      userId: session.user.id,
      chatId,
      title: messages[0]?.content ?? "New Chat", // Using first message consistently for title
      messages,
    });

    // Update the trace with the chatId now that we know it's valid
    trace.update({
      sessionId: chatId,
    });

    initialChatSpan.end({
      output: {
        success: true,
      },
    });
  } catch (error) {
    initialChatSpan.end({
      output: {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
    });

    if (error instanceof Error && error.message === "Chat exists but belongs to a different user") {
      return new Response("Unauthorized - Chat belongs to another user", { status: 403 });
    }
    throw error; // Re-throw other errors
  }

  return createDataStreamResponse({
    execute: async (dataStream) => {
      // If this is a new chat, send the ID to the frontend
      if (isNewChat) {
        dataStream.writeData({
          type: "NEW_CHAT_CREATED",
          chatId,
        });
      }

      const result = streamFromDeepSearch({
        messages,
        telemetry: {
          isEnabled: true,
          functionId: "agent",
          metadata: {
            langfuseTraceId: trace.id,
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
          const saveChatSpan = trace.span({
            name: "save-chat",
            input: {
              userId: session.user.id,
              chatId,
              title: messages[0]?.content ?? "New Chat",
              messageCount: updatedMessages.length,
            },
          });

          try {
            await upsertChat({
              userId: session.user.id,
              chatId,
              title: messages[0]?.content ?? "New Chat", // Using first message consistently for title
              messages: updatedMessages,
            });

            saveChatSpan.end({
              output: {
                success: true,
              },
            });
            
            // Flush the trace to Langfuse
            await langfuse.flushAsync();
          } catch (error) {
            saveChatSpan.end({
              output: {
                success: false,
                error: error instanceof Error ? error.message : "Unknown error",
              },
            });

            console.error("Failed to save chat:", error);
            // We don't return a response here since we're in a stream
            // The error will be handled by the onError callback
          }
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