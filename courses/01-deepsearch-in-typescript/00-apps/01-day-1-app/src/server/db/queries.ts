import { and, desc, eq, gte } from "drizzle-orm";
import { db } from ".";
import { userRequests, users, chats, messages } from "./schema";
import type { Message } from "ai";

const DAILY_REQUEST_LIMIT = 2;

export async function getUserRequestCount(userId: string): Promise<number> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const requests = await db
    .select({ id: userRequests.id })
    .from(userRequests)
    .where(
      and(
        eq(userRequests.userId, userId),
        gte(userRequests.createdAt, today)
      )
    );

  return requests.length;
}

export async function createUserRequest(userId: string) {
  return db.insert(userRequests).values({
    userId,
  });
}

export async function isUserAdmin(userId: string): Promise<boolean> {
  const user = await db
    .select({ isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  return user[0]?.isAdmin ?? false;
}

export async function canMakeRequest(userId: string): Promise<boolean> {
  const [isAdmin, requestCount] = await Promise.all([
    isUserAdmin(userId),
    getUserRequestCount(userId),
  ]);

  return isAdmin || requestCount < DAILY_REQUEST_LIMIT;
}

export async function upsertChat(opts: {
  userId: string;
  chatId: string;
  title: string;
  messages: Message[];
}) {
  const { userId, chatId, title, messages: messagesList } = opts;

  // First check if the chat exists at all
  const existingChat = await db
    .select({ id: chats.id, chatUserId: chats.userId })
    .from(chats)
    .where(eq(chats.id, chatId))
    .limit(1);

  // If chat exists but belongs to different user, throw error
  if (existingChat.length > 0 && existingChat[0]!.chatUserId !== userId) {
    throw new Error("Chat exists but belongs to a different user");
  }

  // If chat doesn't exist, create it
  if (existingChat.length === 0) {
    // Create new chat
    await db.insert(chats).values({
      id: chatId,
      userId,
      title,
    });
  } else {
    // Update chat title and timestamps
    await db
      .update(chats)
      .set({
        title,
        updatedAt: new Date(),
      })
      .where(eq(chats.id, chatId));

    // Delete all existing messages
    await db.delete(messages).where(eq(messages.chatId, chatId));
  }

  // Insert all messages
  if (messagesList.length > 0) {
    await db.insert(messages).values(
      messagesList.map((msg, idx) => ({
        chatId,
        role: msg.role,
        parts: msg.content,
        order: idx,
      }))
    );
  }

  return { success: true };
}

export async function getChat(chatId: string, userId: string) {
  const chat = await db
    .select({
      id: chats.id,
      title: chats.title,
      createdAt: chats.createdAt,
      updatedAt: chats.updatedAt,
    })
    .from(chats)
    .where(and(eq(chats.id, chatId), eq(chats.userId, userId)))
    .limit(1);

  if (!chat.length) {
    return null;
  }

  const chatMessages = await db
    .select({
      role: messages.role,
      content: messages.parts,
    })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(messages.order);

  return {
    ...chat[0],
    messages: chatMessages.map((msg) => ({
      role: msg.role,
      content: msg.content as string,
    })),
  };
}

export async function getChats(userId: string) {
  return db
    .select({
      id: chats.id,
      title: chats.title,
      createdAt: chats.createdAt,
      updatedAt: chats.updatedAt,
    })
    .from(chats)
    .where(eq(chats.userId, userId))
    .orderBy(desc(chats.updatedAt));
} 