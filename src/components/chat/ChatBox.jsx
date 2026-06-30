
import { Card, CardContent } from "@/components/ui/card";
import MessageBubble from "./MessageBubble";
import MessageInput from "./MessageInput";
import { useState, useRef, useEffect, useCallback } from "react";
import ChatHeader from "./ChatHeader";
import { useUser } from "@/hooks/useUser";

// ✅ Utility: Group messages by date
function groupMessagesByDate(messages) {
  return messages.reduce((groups, msg) => {
    const date = new Date(msg.timestamp).toDateString();
    if (!groups[date]) groups[date] = [];
    groups[date].push(msg);
    return groups;
  }, {});
}

// ✅ Utility: Format date label
function formatDateLabel(dateStr) {
  const today = new Date().toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString();

  if (dateStr === today) return "Today";
  if (dateStr === yesterday) return "Yesterday";

  return new Date(dateStr).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function ChatBox({ onBack, username, fullName, avatar_url }) {
  const { user } = useUser();
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [isOnline, setIsOnline] = useState(false);

  const messagesEndRef = useRef(null);
  const scrollContainerRef = useRef(null);
  const socketRef = useRef(null);
  const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

  // ✅ Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // ✅ Format messages helper
  const formatMessages = (list) =>
    list
      .map((msg) => ({
        id: msg.id,
        text: msg.message || "(empty message)",
        sender: msg.sender === user.username ? "me" : "other",
        time: new Date(msg.timestamp).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        timestamp: new Date(msg.timestamp).getTime(),
        isoTime: msg.timestamp,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

  // ✅ Initial chat history (latest 100)
  useEffect(() => {
    if (!username) return;

    const token = document.cookie
      .split("; ")
      .find((row) => row.startsWith("token="))
      ?.split("=")[1];
    if (!token) return;

    const fetchHistory = async () => {
      try {
        setLoading(true);
        const res = await fetch(
          `${API_BASE_URL}/api/messages-app/history/${username}`,
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );

        if (!res.ok) throw new Error("Failed to load history");

        const history = await res.json();
        const formatted = formatMessages(history);

        setMessages(formatted);
        setHasMore(history.length >= 100); // assume API caps at 100
      } catch (err) {
        console.error("Error loading chat history:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchHistory();
  }, [username, user?.username, API_BASE_URL]);

  // ✅ Load older messages on scroll top
  const loadOlderMessages = useCallback(async () => {

    if (!username || loadingMore || !hasMore) return;

    const token = document.cookie
      .split("; ")
      .find((row) => row.startsWith("token="))
      ?.split("=")[1];
    if (!token) return;

    const oldest = messages[0]?.isoTime;
    if (!oldest) return;

    try {
      setLoadingMore(true);

      const res = await fetch(
        `${API_BASE_URL}/api/messages-app/chat/${username}/old-history/?before_timestamp=${encodeURIComponent(
          oldest
        )}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );

      if (!res.ok) throw new Error("Failed to load old history");

      const older = await res.json();
      if (older.length === 0) {
        setHasMore(false);
        return;
      }

      const formatted = formatMessages(older);

      // preserve scroll position after prepend
      const container = scrollContainerRef.current;
      const prevHeight = container.scrollHeight;

      setMessages((prev) => [...formatted, ...prev]);

      requestAnimationFrame(() => {
        const newHeight = container.scrollHeight;
        container.scrollTop = newHeight - prevHeight;
      });
    } catch (err) {
      console.error("Error loading old messages:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [username, messages, hasMore, loadingMore, API_BASE_URL]);

  // ✅ Attach scroll listener
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      if (container.scrollTop < 50 && hasMore && !loadingMore) {
        loadOlderMessages();
      }
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, [loadOlderMessages, hasMore, loadingMore]);

  // ✅ WebSocket connection
  useEffect(() => {
    if (!username) return;

    const token = document.cookie
      .split("; ")
      .find((row) => row.startsWith("token="))
      ?.split("=")[1];
    if (!token) return;

    const wsUrl = `wss://p2p-backend-cek9.onrender.com/ws/chat/${username}/?token=${token}`;
    socketRef.current = new WebSocket(wsUrl);

    socketRef.current.onmessage = async (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }

      // ✅ Handle online status
      if (data.type === "online_status_update" && data.user_id === username) {
        setIsOnline(data.is_online);
        return;
      }

      // ✅ Ignore echo of my own message
      if (data.sender === user.username) return;

      // ✅ Encrypted message
      if (data.message_id) {
        try {
          const res = await fetch(`${API_BASE_URL}/api/messages-app/decrypt/`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ message_id: data.message_id }),
          });

          const result = await res.json();
          setMessages((prev) => [
            ...prev,
            {
              id: data.message_id,
              text: result.decrypted_message || "(empty message)",
              sender: "other",
              time: new Date().toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              }),
              timestamp: Date.now(),
              isoTime: new Date().toISOString(),
            },
          ]);
        } catch (err) {
          console.error("Decrypt error:", err);
        }
      }

      // ✅ Plain text
      else if (data.message) {
        setMessages((prev) => [
          ...prev,
          {
            id: data.id || Date.now(),
            text: data.message,
            sender: "other",
            time: new Date().toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            }),
            timestamp: Date.now(),
            isoTime: new Date().toISOString(),
          },
        ]);
      }
    };

    return () => {
      socketRef.current?.close();
    };
  }, [username, user?.username, API_BASE_URL]);

  // ✅ Send message
  const addMessage = (text) => {
    if (!text.trim()) return;

    const now = new Date();
    const newMsg = {
      id: Date.now(),
      text,
      sender: "me",
      time: now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      timestamp: now.getTime(),
      isoTime: now.toISOString(),
    };
    setMessages((prev) => [...prev, newMsg]);

    if (socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(
        JSON.stringify({ message: text, receiver: username })
      );
    }
  };

  const groupedMessages = groupMessagesByDate(messages);

  return (
    <div className="relative flex flex-col flex-1 h-full">
      {/* ✅ Loader Overlay */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-white/70 z-10">
          <div className="animate-spin h-10 w-10 border-4 border-gray-400 border-t-blue-500 rounded-full"></div>
        </div>
      )}

      <Card className="flex flex-col flex-1 h-full border-0 pb-4 md:p-0 pt-20 md:pt-0">
        <ChatHeader
          onBack={onBack}
          username={username}
          fullName={fullName}
          isOnline={isOnline}
          avatar_url={avatar_url}
        />

        {/* Messages */}
        <CardContent
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto p-0 space-y-1"
        >
          {loadingMore && (
            <div className="flex justify-center py-2 text-gray-500 text-sm">
              Loading older messages...
            </div>
          )}

          {Object.entries(groupedMessages).map(([date, msgs]) => (
            <div key={date}>
              {/* Date Separator */}
              <div className="flex justify-center my-4">
                <span className="bg-gray-200 text-gray-700 text-sm px-4 py-1 rounded-full">
                  {formatDateLabel(date)}
                </span>
              </div>

              {msgs.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  {...msg}
                  senderName={msg.sender === "other" ? fullName || "User" : "Me"}
                  avatar_url={avatar_url}
                  meurl={user.avatar_url}
                />
              ))}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </CardContent>

        {/* Input */}
        <MessageInput onSend={addMessage} />
      </Card>
    </div>
  );
}
