"use client";

import type { Message } from "ai";
import { useChat } from "@ai-sdk/react";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { StickToBottom } from "use-stick-to-bottom";
import { ChatMessage } from "~/components/chat-message";
import { SignInModal } from "~/components/sign-in-modal";
import { isNewChatCreated } from "~/utils";

interface ChatProps {
  userName: string;
  chatId: string;
  isNewChat: boolean;
  initialMessages?: Message[];
}

export const ChatPage = ({ userName, chatId, isNewChat, initialMessages }: ChatProps) => {
  const router = useRouter();
  const [isSignInModalOpen, setIsSignInModalOpen] = useState(false);
  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    isLoading,
    error,
    data
  } = useChat({
    initialMessages,
    body: {
      chatId,
      isNewChat,
    },
    onError: (error) => {
      // Show sign in modal if unauthorized
      if (error.message.includes("401") || error.message.includes("Unauthorized")) {
        setIsSignInModalOpen(true);
        console.log(error);
      }
    },
  });

  useEffect(() => {
    const lastDataItem = data?.[data.length - 1];
    if (lastDataItem && isNewChatCreated(lastDataItem)) {
      router.push(`?id=${lastDataItem.chatId}`);
    }
  }, [data, router]);

  const handleModalClose = () => {
    setIsSignInModalOpen(false);
  };

  return (
    <>
      <div className="flex flex-1 flex-col">
        <StickToBottom 
          className="overflow-auto mx-auto w-full max-w-[65ch] flex-1 relative [&>div]:scrollbar-thin [&>div]:scrollbar-track-gray-800 [&>div]:scrollbar-thumb-gray-600 [&>div]:hover:scrollbar-thumb-gray-500"
          resize="smooth"
          initial="smooth"
          role="log"
          aria-label="Chat messages"
        >
          <StickToBottom.Content className="flex flex-col gap-4 p-4">
            {messages.map((message) => {
              return (
                <ChatMessage
                  key={message.id}
                  text={message.content}
                  role={message.role}
                  userName={userName}
                  parts={message.parts}
                />
              );
            })}
          </StickToBottom.Content>
        </StickToBottom>

        <div className="border-t border-gray-700">
          <form
            onSubmit={handleSubmit}
            className="mx-auto max-w-[65ch] p-4"
          >
            <div className="flex gap-2">
              <input
                value={input}
                onChange={handleInputChange}
                placeholder="Say something..."
                autoFocus
                aria-label="Chat input"
                className="flex-1 rounded border border-gray-700 bg-gray-800 p-2 text-gray-200 placeholder-gray-400 focus:border-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={isLoading}
                className="rounded bg-gray-700 px-4 py-2 text-white hover:bg-gray-600 focus:border-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-400 disabled:opacity-50 disabled:hover:bg-gray-700"
              >
                {isLoading ? <Loader2 className="size-4 animate-spin" /> : "Send"}
              </button>
            </div>
          </form>
        </div>
      </div>

      <SignInModal isOpen={isSignInModalOpen} onClose={handleModalClose} />
    </>
  );
};
