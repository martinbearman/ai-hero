import type { Message } from "ai";
import { streamText, createDataStreamResponse, appendResponseMessages } from "ai";
import { z } from "zod";
import { model } from "~/models.ts";
import { auth } from "~/server/auth";
import { searchSerper } from "~/serper";
import { canMakeRequest, createUserRequest, upsertChat } from "~/server/db/queries";
import { Langfuse } from "langfuse";
import { env } from "~/env";
import { bulkCrawlWebsites } from "~/scraper";
import { cacheWithRedis } from "~/server/redis/redis";

const langfuse = new Langfuse({
  environment: env.NODE_ENV,
});

export const maxDuration = 60;

const SYSTEM_PROMPT = `You are a helpful AI assistant with the ability to search the web for real-time information and scrape web pages for detailed content.

The current date and time is: ${new Date().toLocaleString('en-GB', { timeZone: 'GMT' })} GMT

When users ask for up-to-date or current information:
- ALWAYS mention the current date in your responses
- ALWAYS include the date/time when the information was published in your responses
- If information is more than 6 months old, explicitly warn the user
- For time-sensitive queries (weather, news, sports), emphasize the timestamp of the data

When answering questions:
- ALWAYS search the web first to get the most up-to-date information using the searchWeb tool
- You MUST ALWAYS use the scrapePages tool after searching to get detailed content from the most relevant pages
- For EVERY search query, you MUST select 4-6 diverse URLs to scrape, including:
  * Official documentation or primary sources
  * Recent blog posts or articles from different authors/sites
  * Community discussions or forums
  * Expert opinions or technical analyses
  * News articles or press releases when relevant
- NEVER scrape fewer than 4 URLs unless absolutely necessary
- NEVER rely on a single source or type of source
- NEVER rely only on search result snippets - you must get the full content using scrapePages
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

Required Tool Usage Flow:
1. ALWAYS start by using searchWeb to find relevant pages
2. ALWAYS select 4-6 diverse URLs from different types of sources
3. ALWAYS use scrapePages to get detailed content from ALL selected URLs
4. NEVER skip the scrapePages step - it is required for every response
5. Cross-reference and verify information across multiple sources
6. Combine and synthesize the information, highlighting agreements and differences
7. Always cite your sources using proper markdown links

Remember to:
1. Search AND scrape for every factual question - no exceptions
2. Get detailed content through scraping - never rely just on search snippets
3. Use diverse sources - mix official docs, blogs, forums, and expert analysis
4. NEVER show raw URLs - always wrap them in markdown links with descriptive titles
5. Be transparent about the recency and reliability of your sources
6. Highlight when sources agree or disagree on key points`;

// Cache the scrapePages function with Redis
const scrapePagesWithCache = cacheWithRedis(
  "scrapePages",
  async (urls: string[], abortSignal?: AbortSignal) => {
    const result = await bulkCrawlWebsites({ urls });
    if (!result.success) {
      return {
        error: result.error,
        results: result.results.map(r => ({
          url: r.url,
          content: r.result.success ? r.result.data : `Error: ${r.result.error}`,
          error: !r.result.success
        }))
      };
    }
    return {
      results: result.results.map(r => ({
        url: r.url,
        content: r.result.data,
        error: false
      }))
    };
  }
);

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

      const result = streamText({
        model,
        messages,
        maxSteps: 10,
        system: SYSTEM_PROMPT,
        experimental_telemetry: {
          isEnabled: true,
          functionId: "agent",
          metadata: {
            langfuseTraceId: trace.id,
          }, 
        },
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
                date: result.date,
              }));
            },
          },
          scrapePages: {
            parameters: z.object({
              urls: z.array(z.string()).describe("Array of URLs to scrape (max 5)").max(5),
            }),
            execute: async ({ urls }, { abortSignal }) => {
              return scrapePagesWithCache(urls, abortSignal);
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