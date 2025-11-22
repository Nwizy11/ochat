// src/App.js - COMPLETELY FIXED REAL-TIME MESSAGING
import React, { useState, useEffect, useRef } from 'react';
import { MessageCircle, Send, Copy, Check, Plus, User, List } from 'lucide-react';
import io from 'socket.io-client';
import axios from 'axios';
import './app.css';

const API_URL = 'https://anonym-backend.onrender.com';

function App() {
  const [view, setView] = useState('loading');
  const [myLinkId, setMyLinkId] = useState(null);
  const [myCreatorId, setMyCreatorId] = useState(null);
  const [activeConvId, setActiveConvId] = useState(null);
  const [joinLinkId, setJoinLinkId] = useState('');
  const [conversations, setConversations] = useState([]);
  const [currentConv, setCurrentConv] = useState(null);
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const [isCreator, setIsCreator] = useState(false);
  const [typingUser, setTypingUser] = useState(null);
  const [loading, setLoading] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);
  const [myLinks, setMyLinks] = useState([]);
  const [myChatHistory, setMyChatHistory] = useState([]);
  const [showNotification, setShowNotification] = useState(false);
  
  const messagesEndRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const audioContextRef = useRef(null);
  const socketRef = useRef(null);
  const messageQueueRef = useRef([]);
  const reconnectTimeoutRef = useRef(null);

  // Initialize audio context
  useEffect(() => {
    audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
    return () => {
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    };
  }, []);

  // Play notification sound
  const playNotificationSound = () => {
    if (!audioContextRef.current) return;
    try {
      const ctx = audioContextRef.current;
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);
      
      oscillator.frequency.setValueAtTime(800, ctx.currentTime);
      oscillator.frequency.setValueAtTime(600, ctx.currentTime + 0.1);
      
      gainNode.gain.setValueAtTime(0.3, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
      
      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + 0.3);
    } catch (error) {
      console.error('Error playing notification sound:', error);
    }
  };

  const isPageVisible = () => document.visibilityState === 'visible';

  // ✅ CRITICAL FIX: Initialize socket with proper cleanup and reconnection
  const initializeSocket = () => {
    if (socketRef.current?.connected) {
      console.log('Socket already connected');
      return socketRef.current;
    }

    console.log('🔌 Initializing socket connection to:', API_URL);
    
    const socket = io(API_URL, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
      transports: ['websocket', 'polling'],
      upgrade: true,
      forceNew: false
    });
    
    socket.on('connect', () => {
      console.log('✅ Connected to server, socket ID:', socket.id);
      setSocketConnected(true);
      
      // Rejoin conversation if we were in one
      if (activeConvId) {
        console.log('♻️ Rejoining conversation:', activeConvId);
        socket.emit('join-conversation', { 
          convId: activeConvId, 
          isCreator 
        });
      }
      
      // Rejoin link if creator
      if (myLinkId && myCreatorId && isCreator) {
        console.log('♻️ Rejoining link:', myLinkId);
        socket.emit('join-link', { linkId: myLinkId, creatorId: myCreatorId });
      }

      // Process queued messages
      while (messageQueueRef.current.length > 0) {
        const queuedMsg = messageQueueRef.current.shift();
        socket.emit('send-message', queuedMsg);
      }
    });
    
    socket.on('disconnect', (reason) => {
      console.log('⚠️ Disconnected from server:', reason);
      setSocketConnected(false);
    });
    
    socket.on('connect_error', (error) => {
      console.error('❌ Connection error:', error.message);
      setSocketConnected(false);
    });
    
    socket.on('reconnect', (attemptNumber) => {
      console.log('🔄 Reconnected after', attemptNumber, 'attempts');
    });
    
    // ✅ CRITICAL: Handle incoming messages
    socket.on('new-message', ({ convId, message: newMessage }) => {
      console.log('📩 Received new-message event:', { convId, message: newMessage, activeConvId });
      
      if (convId === activeConvId) {
        setCurrentConv(prev => {
          if (!prev) return prev;
          
          // Check if message already exists (avoid duplicates)
          const messageExists = prev.messages?.some(m => m.id === newMessage.id);
          if (messageExists) {
            console.log('⚠️ Message already exists, skipping:', newMessage.id);
            return prev;
          }
          
          const updated = {
            ...prev,
            messages: [...(prev.messages || []), newMessage],
            lastMessage: newMessage.timestamp
          };
          console.log('💾 Updated currentConv, new message count:', updated.messages.length);
          return updated;
        });
        
        // Play sound if message is from other person
        if (newMessage.isCreator !== isCreator && !isPageVisible()) {
          playNotificationSound();
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('New Message', {
              body: newMessage.text.substring(0, 50) + (newMessage.text.length > 50 ? '...' : ''),
              icon: '/favicon.ico',
              tag: 'chat-message'
            });
          }
        }
      }
      
      // Update conversations list if creator
      if (isCreator) {
        setConversations(prev => 
          prev.map(conv => {
            if (conv.id === convId) {
              const isViewingThisChat = (activeConvId === convId);
              const shouldIncrementUnread = !newMessage.isCreator && !isViewingThisChat;
              
              if (shouldIncrementUnread && !isPageVisible()) {
                playNotificationSound();
              }
              
              return {
                ...conv,
                messages: [...(conv.messages || []), newMessage],
                lastMessage: newMessage.timestamp,
                unreadCount: shouldIncrementUnread ? (conv.unreadCount || 0) + 1 : (conv.unreadCount || 0)
              };
            }
            return conv;
          })
        );
      }
    });

    socket.on('load-messages', ({ messages }) => {
      console.log('📥 Loaded messages:', messages?.length || 0);
      if (activeConvId) {
        setCurrentConv(prev => ({
          ...prev,
          id: activeConvId,
          messages: messages || []
        }));
      }
    });

    socket.on('user-typing', ({ isCreator: typingIsCreator }) => {
      setTypingUser(typingIsCreator ? 'creator' : 'anonymous');
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => setTypingUser(null), 3000);
    });

    socket.on('user-stop-typing', () => {
      setTypingUser(null);
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    });

    socket.on('load-conversations', ({ conversations: convs }) => {
      console.log('📋 Loaded conversations:', convs.length);
      const conversationsWithUnread = convs.map(conv => ({
        ...conv,
        unreadCount: calculateUnreadCount(conv)
      }));
      setConversations(conversationsWithUnread || []);
    });

    socket.on('new-conversation', ({ conversation }) => {
      console.log('🆕 New conversation added:', conversation.id);
      setConversations(prev => {
        const exists = prev.some(c => c.id === conversation.id);
        if (exists) return prev;
        return [...prev, { 
          ...conversation, 
          unreadCount: calculateUnreadCount(conversation)
        }];
      });
    });

    socket.on('conversation-updated', ({ conversation }) => {
      console.log('🔄 Conversation updated:', conversation.id);
      setConversations(prev => {
        const exists = prev.some(c => c.id === conversation.id);
        if (exists) {
          return prev.map(conv => {
            if (conv.id === conversation.id) {
              const isViewingThisChat = (activeConvId === conversation.id);
              
              if (isViewingThisChat) {
                return { ...conv, ...conversation, unreadCount: 0 };
              }
              
              const oldMessageCount = conv.messages?.length || 0;
              const newMessageCount = conversation.messages?.length || 0;
              
              if (newMessageCount > oldMessageCount) {
                const newMessages = conversation.messages.slice(oldMessageCount);
                const newUnreadCount = newMessages.filter(msg => !msg.isCreator).length;
                return {
                  ...conv,
                  ...conversation,
                  unreadCount: (conv.unreadCount || 0) + newUnreadCount
                };
              }
              
              return { ...conv, ...conversation };
            }
            return conv;
          });
        } else {
          return [...prev, { 
            ...conversation, 
            unreadCount: conversation.messages?.filter(msg => !msg.isCreator).length || 0
          }];
        }
      });
    });
    
    socketRef.current = socket;
    return socket;
  };

  // Initialize socket on mount
  useEffect(() => {
    initializeSocket();
    
    return () => {
      if (socketRef.current) {
        console.log('🔌 Cleaning up socket');
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
    };
  }, []);

  // Rejoin conversation when activeConvId changes
  useEffect(() => {
    if (activeConvId && socketRef.current?.connected) {
      console.log('🔗 Joining conversation:', activeConvId);
      socketRef.current.emit('join-conversation', { 
        convId: activeConvId, 
        isCreator 
      });
    }
  }, [activeConvId, isCreator]);

  // Check for saved creator session or direct link on mount
  useEffect(() => {
    const initializeApp = async () => {
      const urlParams = new URLSearchParams(window.location.search);
      const linkParam = urlParams.get('link');
      const creatorParam = urlParams.get('creator');
      
      loadMyLinks();
      await loadMyChatHistory();
      
      if (creatorParam) {
        await restoreCreatorSession(creatorParam);
      } else if (linkParam) {
        await handleDirectLink(linkParam);
      } else {
        setView('home');
      }
    };
    
    initializeApp();
  }, []);

  // Auto scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentConv?.messages]);

  // Request notification permission
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  // Show notification for active chats
  useEffect(() => {
    if (view === 'home' && !isCreator) {
      setShowNotification(myChatHistory.length > 0);
    } else {
      setShowNotification(false);
    }
  }, [view, myChatHistory, isCreator]);

  const loadMyLinks = () => {
    try {
      const saved = localStorage.getItem('my_chat_links');
      if (saved) {
        setMyLinks(JSON.parse(saved));
      }
    } catch (error) {
      console.error('Error loading links:', error);
    }
  };

  const saveMyLink = (linkId, creatorId) => {
    try {
      const saved = localStorage.getItem('my_chat_links');
      const links = saved ? JSON.parse(saved) : [];
      
      if (!links.some(l => l.linkId === linkId)) {
        links.unshift({ linkId, creatorId, createdAt: Date.now() });
        const trimmedLinks = links.slice(0, 10);
        localStorage.setItem('my_chat_links', JSON.stringify(trimmedLinks));
        setMyLinks(trimmedLinks);
      }
    } catch (error) {
      console.error('Error saving link:', error);
    }
  };

  const removeMyLink = (linkId) => {
    try {
      const saved = localStorage.getItem('my_chat_links');
      if (saved) {
        const links = JSON.parse(saved);
        const filtered = links.filter(l => l.linkId !== linkId);
        localStorage.setItem('my_chat_links', JSON.stringify(filtered));
        setMyLinks(filtered);
      }
    } catch (error) {
      console.error('Error removing link:', error);
    }
  };

  const restoreCreatorSession = async (linkId) => {
    try {
      const response = await axios.get(`${API_URL}/api/links/${linkId}`);
      const { link } = response.data;
      
      if (link) {
        setMyLinkId(linkId);
        setMyCreatorId(link.creatorId);
        setIsCreator(true);
        setView('creator');
        
        if (socketRef.current?.connected) {
          socketRef.current.emit('join-link', { linkId, creatorId: link.creatorId });
        }
        
        const convResponse = await axios.get(`${API_URL}/api/links/${linkId}/conversations`);
        setConversations(convResponse.data.conversations || []);
      }
    } catch (error) {
      console.error('Error restoring session:', error);
      window.history.replaceState({}, '', '/');
      setView('home');
    }
  };

  const handleDirectLink = async (linkId) => {
    const saved = localStorage.getItem('my_chat_history');
    const chatHistory = saved ? JSON.parse(saved) : [];
    
    try {
      const existingChat = chatHistory.find(chat => chat.linkId === linkId);
      
      if (existingChat) {
        try {
          const response = await axios.get(`${API_URL}/api/conversations/${existingChat.convId}`);
          const { conversation } = response.data;
          
          setActiveConvId(existingChat.convId);
          setIsCreator(false);
          setCurrentConv({
            id: existingChat.convId,
            linkId: conversation.linkId,
            messages: conversation.messages || [],
            createdAt: conversation.createdAt,
            lastMessage: conversation.lastMessage
          });
          setView('chat');
          
          updateChatHistoryActivity(existingChat.convId);
          
        } catch (error) {
          console.error('Failed to restore conversation:', error);
          removeChatHistory(existingChat.convId);
          await createNewConversation(linkId);
        }
      } else {
        await createNewConversation(linkId);
      }
    } catch (error) {
      console.error('Error in handleDirectLink:', error);
      alert('Invalid link or server error');
      window.history.replaceState({}, '', '/');
      setView('home');
    }
  };

  const createNewConversation = async (linkId) => {
    const verifyResponse = await axios.get(`${API_URL}/api/links/${linkId}/verify`);
    
    if (verifyResponse.data.exists) {
      const response = await axios.post(`${API_URL}/api/conversations/create`, { linkId });
      const { conversation } = response.data;
      
      setActiveConvId(conversation.id);
      setCurrentConv(conversation);
      setIsCreator(false);
      setView('chat');
      
      saveChatHistory(linkId, conversation.id);
    } else {
      alert('Invalid or expired link');
      window.history.replaceState({}, '', '/');
      setView('home');
    }
  };

  const saveReadStatus = (convId, readUpToMessageCount) => {
    try {
      const readStatus = JSON.parse(localStorage.getItem('chat_read_status') || '{}');
      readStatus[convId] = { readUpToMessageCount, timestamp: Date.now() };
      localStorage.setItem('chat_read_status', JSON.stringify(readStatus));
    } catch (error) {
      console.error('Error saving read status:', error);
    }
  };

  const getReadStatus = (convId) => {
    try {
      const readStatus = JSON.parse(localStorage.getItem('chat_read_status') || '{}');
      return readStatus[convId] || null;
    } catch (error) {
      return null;
    }
  };

  const calculateUnreadCount = (conv) => {
    const readStatus = getReadStatus(conv.id);
    if (!readStatus) {
      return conv.messages ? conv.messages.filter(m => !m.isCreator).length : 0;
    }
    
    const totalMessages = conv.messages?.length || 0;
    if (totalMessages <= readStatus.readUpToMessageCount) return 0;
    
    const newMessages = conv.messages.slice(readStatus.readUpToMessageCount);
    return newMessages.filter(m => !m.isCreator).length;
  };

  const loadMyChatHistory = () => {
    return new Promise((resolve) => {
      try {
        const saved = localStorage.getItem('my_chat_history');
        if (saved) {
          const history = JSON.parse(saved);
          setMyChatHistory(history);
          resolve(history);
        } else {
          resolve([]);
        }
      } catch (error) {
        resolve([]);
      }
    });
  };

  const saveChatHistory = (linkId, convId) => {
    try {
      const saved = localStorage.getItem('my_chat_history');
      const history = saved ? JSON.parse(saved) : [];
      
      const existingIndex = history.findIndex(h => h.linkId === linkId);
      
      if (existingIndex !== -1) {
        history[existingIndex] = {
          ...history[existingIndex],
          convId,
          lastActive: Date.now()
        };
      } else {
        history.unshift({
          linkId,
          convId,
          joinedAt: Date.now(),
          lastActive: Date.now()
        });
      }
      
      const trimmed = history.slice(0, 20);
      localStorage.setItem('my_chat_history', JSON.stringify(trimmed));
      setMyChatHistory(trimmed);
    } catch (error) {
      console.error('Error saving chat history:', error);
    }
  };

  const updateChatHistoryActivity = (convId) => {
    try {
      const saved = localStorage.getItem('my_chat_history');
      if (saved) {
        const history = JSON.parse(saved);
        const updated = history.map(h => 
          h.convId === convId ? { ...h, lastActive: Date.now() } : h
        );
        localStorage.setItem('my_chat_history', JSON.stringify(updated));
        setMyChatHistory(updated);
      }
    } catch (error) {
      console.error('Error updating chat history:', error);
    }
  };

  const removeChatHistory = (convId) => {
    try {
      const saved = localStorage.getItem('my_chat_history');
      if (saved) {
        const history = JSON.parse(saved);
        const filtered = history.filter(h => h.convId !== convId);
        localStorage.setItem('my_chat_history', JSON.stringify(filtered));
        setMyChatHistory(filtered);
      }
    } catch (error) {
      console.error('Error removing chat history:', error);
    }
  };

  const returnToActiveChat = async () => {
    if (myChatHistory.length > 0) {
      const activeChat = myChatHistory[0];
      window.location.href = `/?link=${activeChat.linkId}`;
    }
  };

  // ✅ CRITICAL FIX: Optimistic UI update + queue messages if offline
  const sendMessageHandler = () => {
    if (!message.trim() || !activeConvId) return;
    
    const messageText = message.trim();
    setMessage('');
    
    // Create optimistic message
    const optimisticMessage = {
      id: Date.now() + Math.random(),
      text: messageText,
      isCreator,
      timestamp: Date.now()
    };
    
    // Add to UI immediately (optimistic update)
    setCurrentConv(prev => ({
      ...prev,
      messages: [...(prev.messages || []), optimisticMessage],
      lastMessage: Date.now()
    }));
    
    // Send to server
    if (socketRef.current?.connected) {
      socketRef.current.emit('send-message', {
        convId: activeConvId,
        message: messageText,
        isCreator
      });
      socketRef.current.emit('stop-typing', { convId: activeConvId });
    } else {
      // Queue message if disconnected
      console.log('⚠️ Socket disconnected, queuing message');
      messageQueueRef.current.push({
        convId: activeConvId,
        message: messageText,
        isCreator
      });
    }
    
    if (!isCreator) {
      updateChatHistoryActivity(activeConvId);
    }
  };

  const handleTyping = () => {
    if (!activeConvId || !socketRef.current?.connected) return;
    
    socketRef.current.emit('typing', { convId: activeConvId, isCreator });
    
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      if (socketRef.current?.connected) {
        socketRef.current.emit('stop-typing', { convId: activeConvId });
      }
    }, 1000);
  };

  const createNewLink = async () => {
    setLoading(true);
    try {
      const response = await axios.post(`${API_URL}/api/links/create`);
      const { linkId, creatorId } = response.data;
      
      setMyLinkId(linkId);
      setMyCreatorId(creatorId);
      setIsCreator(true);
      setView('creator');
      
      saveMyLink(linkId, creatorId);
      window.history.pushState({}, '', `/?creator=${linkId}`);
      
      if (socketRef.current?.connected) {
        socketRef.current.emit('join-link', { linkId, creatorId });
      }
      
      const convResponse = await axios.get(`${API_URL}/api/links/${linkId}/conversations`);
      const convs = convResponse.data.conversations || [];
      setConversations(convs.map(conv => ({
        ...conv,
        unreadCount: calculateUnreadCount(conv)
      })));
    } catch (error) {
      console.error('Error creating link:', error);
      alert('Failed to create link. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const openExistingLink = async (linkId, creatorId) => {
    setLoading(true);
    try {
      const response = await axios.get(`${API_URL}/api/links/${linkId}`);
      const { link } = response.data;
      
      if (link) {
        setMyLinkId(linkId);
        setMyCreatorId(creatorId);
        setIsCreator(true);
        setView('creator');
        
        window.history.pushState({}, '', `/?creator=${linkId}`);
        
        if (socketRef.current?.connected) {
          socketRef.current.emit('join-link', { linkId, creatorId });
        }
        
        const convResponse = await axios.get(`${API_URL}/api/links/${linkId}/conversations`);
        const convs = convResponse.data.conversations || [];
        setConversations(convs.map(conv => ({
          ...conv,
          unreadCount: calculateUnreadCount(conv)
        })));
      }
    } catch (error) {
      console.error('Error opening link:', error);
      alert('This link no longer exists or has expired.');
      removeMyLink(linkId);
    } finally {
      setLoading(false);
    }
  };

  const joinWithLink = async () => {
    if (!joinLinkId.trim()) {
      alert('Please enter a link ID');
      return;
    }
    window.location.href = `/?link=${joinLinkId}`;
  };

  const openConversation = async (convId) => {
    setLoading(true);
    try {
      const response = await axios.get(`${API_URL}/api/conversations/${convId}`);
      const { conversation } = response.data;
      
      setActiveConvId(convId);
      setCurrentConv(conversation);
      setView('chat');
      
      setConversations(prev => 
        prev.map(conv => {
          if (conv.id === convId) {
            saveReadStatus(convId, conversation.messages?.length || 0);
            return { ...conv, unreadCount: 0, lastReadTime: Date.now() };
          }
          return conv;
        })
      );
    } catch (error) {
      console.error('Error opening conversation:', error);
      alert('Failed to open conversation');
    } finally {
      setLoading(false);
    }
  };

  const copyLink = () => {
    const fullLink = `${window.location.origin}/?link=${myLinkId}`;
    
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(fullLink)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        })
        .catch(() => copyToClipboardFallback(fullLink));
    } else {
      copyToClipboardFallback(fullLink);
    }
  };

  const copyToClipboardFallback = (text) => {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    document.body.appendChild(textArea);
    textArea.select();
    
    try {
      document.execCommand('copy');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      alert(`Copy this link: ${text}`);
    }
    
    document.body.removeChild(textArea);
  };

  const goBack = () => {
    if (view === 'chat' && isCreator) {
      setView('creator');
      setActiveConvId(null);
      setCurrentConv(null);
      window.history.pushState({}, '', `/?creator=${myLinkId}`);
    } else {
      setView('home');
      setMyLinkId(null);
      setMyCreatorId(null);
      setActiveConvId(null);
      setConversations([]);
      setCurrentConv(null);
      setIsCreator(false);
      window.history.pushState({}, '', '/');
    }
  };

  const viewConversationList = () => {
    if (myLinkId) {
      setView('creator');
      setActiveConvId(null);
      setCurrentConv(null);
      window.history.pushState({}, '', `/?creator=${myLinkId}`);
    }
  };

  const formatTime = (timestamp) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return date.toLocaleDateString();
  };

  if (view === 'loading' || loading) {
    return (
      <div className="container">
        <div className="home-card">
          <div className="logo-container">
            <MessageCircle size={48} color="#667eea" className="spinning" />
          </div>
          <p className="subtitle">Loading...</p>
        </div>
      </div>
    );
  }

  if (view === 'home') {
    return (
      <div className="container">
        <div className="home-card">
          {showNotification && myChatHistory.length > 0 && (
            <button 
              onClick={returnToActiveChat}
              className="active-chat-button"
              title="Return to active chat"
            />
          )}

          <div className="logo-container">
            <MessageCircle size={48} color="#667eea" />
          </div>
          <h1 className="title">OChat</h1>
          <p className="subtitle">Chat anonymously with anyone, no sign-up required</p>
          
          <button onClick={createNewLink} className="primary-button" disabled={loading}>
            <Plus size={20} />
            <span>Create New Chat Link</span>
          </button>

          <div className="divider">
            <span className="divider-text">OR</span>
          </div>

          <input
            type="text"
            placeholder="Paste link ID to join"
            className="input"
            value={joinLinkId}
            onChange={(e) => setJoinLinkId(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && joinWithLink()}
          />
          
          <button onClick={joinWithLink} className="secondary-button">
            Join Chat
          </button>

          {myLinks.length > 0 && (
            <>
              <div className="divider" style={{ marginTop: '32px' }}>
                <span className="divider-text">MY CHAT LINKS</span>
              </div>
              
              <div className="my-links-list">
                {myLinks.map((link) => (
                  <div key={link.linkId} className="my-link-item">
                    <div className="my-link-info">
                      <div>
                        <div className="my-link-id">{link.linkId}</div>
                        <div className="my-link-date">
                          Created {formatTime(link.createdAt)}
                        </div>
                      </div>
                    </div>
                    <div className="my-link-actions">
                      <button
                        onClick={() => openExistingLink(link.linkId, link.creatorId)}
                        className="my-link-open-btn"
                      >
                        Open
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeMyLink(link.linkId);
                        }}
                        className="my-link-delete-btn"
                        title="Remove from list"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="features">
            <p className="feature">🔒 Completely anonymous</p>
            <p className="feature">💬 Real-time messaging</p>
            <p className="feature">🚀 No account needed</p>
            <p className="feature"><a href="https://ochat.fun/about.html">📃 More about Ochat </a></p>
          </div>
        </div>
      </div>
    );
  }

  if (view === 'creator') {
    return (
      <div className="container">
        <div className="app-container">
          <div className="header">
            <div>
              <h2 className="header-title">Your Chat Link</h2>
              <p className="header-subtitle">
                {conversations.length} conversation{conversations.length !== 1 ? 's' : ''}
              </p>
            </div>
            <button onClick={goBack} className="back-button">
              Home
            </button>
          </div>

          <div className="link-section">
            <div className="link-info">
              <span className="link-label">SHARE THIS LINK</span>
              <span className="link-id">{myLinkId}</span>
            </div>
            <button onClick={copyLink} className="copy-button">
              {copied ? <Check size={16} /> : <Copy size={16} />}
              <span>{copied ? 'Copied!' : 'Copy'}</span>
            </button>
          </div>

          <div className="conversation-list">
            {conversations.length === 0 ? (
              <div className="empty-state">
                <MessageCircle size={64} color="#ddd" />
                <p className="empty-text">No conversations yet</p>
                <p className="empty-subtext">Share your link to start chatting</p>
                <p className="empty-hint">Anonymous users will appear here</p>
              </div>
            ) : (
              conversations.map((conv) => (
                <div
                  key={conv.id}
                  className="conversation-item"
                  onClick={() => openConversation(conv.id)}
                >
                  <div className="avatar">
                    <User size={24} color="#667eea" />
                  </div>
                  <div className="conv-info">
                    <div className="conv-header">
                      <span className="conv-name">Anonymous User</span>
                      <span className="conv-time">
                        {formatTime(conv.lastMessage || conv.createdAt)}
                      </span>
                    </div>
                    <p className="last-message">
                      {conv.messages && conv.messages.length > 0
                        ? conv.messages[conv.messages.length - 1].text
                        : 'No messages yet'}
                    </p>
                  </div>
                  {conv.unreadCount > 0 && (
                    <div className="unread-badge">{conv.unreadCount}</div>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    );
  }

  if (view === 'chat') {
    return (
      <div className="container">
        <div className="app-container">
          <div className="chat-header">
            <button onClick={goBack} className="back-button-small">
              ←
            </button>
            {isCreator && (
              <button onClick={viewConversationList} className="list-button" title="View all conversations">
                <List size={20} />
              </button>
            )}
            <div className="chat-header-info">
              <div className="avatar-small">
                <User size={20} color="#667eea" />
              </div>
              <div>
                <h3 className="chat-title">
                  {isCreator ? 'Anonymous User' : 'Chat Creator'}
                </h3>
                {socketConnected && <p className="chat-status">● Online</p>}
              </div>
            </div>
          </div>

          {!socketConnected && (
            <div className="connection-warning">
              <span>⚠️ Disconnected from server</span>
              <button onClick={() => initializeSocket()} className="reconnect-btn">
                Reconnect
              </button>
            </div>
          )}

          <div className="messages-container">
            {!currentConv || currentConv.messages.length === 0 ? (
              <div className="empty-chat">
                <MessageCircle size={64} color="#ddd" />
                <p className="empty-chat-text">No messages yet. Say hi! 👋</p>
              </div>
            ) : (
              currentConv.messages.map((msg, idx) => (
                <div
                  key={msg.id || idx}
                  className="message-wrapper"
                  style={{
                    justifyContent: msg.isCreator === isCreator ? 'flex-end' : 'flex-start'
                  }}
                >
                  <div className={msg.isCreator === isCreator ? 'my-message' : 'their-message'}>
                    <p className="message-text">{msg.text}</p>
                    <div className="message-time">{formatTime(msg.timestamp)}</div>
                  </div>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          {typingUser && (
            <div className="typing-indicator">
              {typingUser === 'creator' && !isCreator && 'Chat creator is typing...'}
              {typingUser === 'anonymous' && isCreator && 'Anonymous user is typing...'}
            </div>
          )}

          <div className="input-container">
            <input
              type="text"
              placeholder={socketConnected ? "Type a message..." : "Disconnected..."}
              className="message-input"
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                handleTyping();
              }}
              onKeyPress={(e) => e.key === 'Enter' && sendMessageHandler()}
              disabled={!socketConnected}
            />
            <button
              onClick={sendMessageHandler}
              className="send-button"
              disabled={!message.trim() || !socketConnected}
            >
              <Send size={20} />
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

export default App;