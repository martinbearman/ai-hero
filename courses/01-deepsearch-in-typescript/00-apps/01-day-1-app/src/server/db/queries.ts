import { and, eq, gte } from "drizzle-orm";
import { db } from ".";
import { userRequests, users } from "./schema";

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