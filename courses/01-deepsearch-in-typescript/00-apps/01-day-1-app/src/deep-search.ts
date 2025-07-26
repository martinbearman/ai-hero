import type { Message, TelemetrySettings } from "ai";
import { streamText } from "ai";
import { z } from "zod";
import { model } from "~/models";
import { searchSerper } from "~/serper";
import { bulkCrawlWebsites } from "~/scraper";
import { cacheWithRedis } from "~/server/redis/redis";

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

export const streamFromDeepSearch = (opts: {
  messages: Message[];
  onFinish: Parameters<typeof streamText>[0]["onFinish"];
  telemetry: TelemetrySettings;
}) =>
  streamText({
    model,
    messages: opts.messages,
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
    onFinish: opts.onFinish,
    experimental_telemetry: opts.telemetry,
  });

export async function askDeepSearch(messages: Message[]) {
  const result = streamFromDeepSearch({
    messages,
    onFinish: () => {}, // just a stub
    telemetry: {
      isEnabled: false,
    },
  });

  // Consume the stream - without this,
  // the stream will never finish
  await result.consumeStream();

  return result.text;
} 