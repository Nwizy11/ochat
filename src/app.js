// src/App.js - PERMANENT FIX - Proper message deduplication
import React, { useState, useEffect, useRef } from 'react';
import { MessageCircle, Send, Copy, Check, Plus, User, List } from 'lucide-react';
import io from 'socket.io-client';
import axios from 'axios';
import ReactGA from 'react-ga4';
import './app.css';

const TRACKING_ID = 'G-FE98DD5ZS8';
ReactGA.initialize(TRACKING_ID);

const API_URL = "https://anonym-backend.onrender.com";
let socket;

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
  const reconnectAttempts = useRef(0);
  const pendingMessages = useRef([]);
  const processedMessageIds = useRef(new Set()); // Track processed message IDs

  useEffect(() => {
    audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
    return () => {
      if (audioContextRef.current) {
        audioContextRef.current.close();
      }
    };
  }, []);

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

  // PERMANENT FIX: Generate consistent message ID based on content
  const generateMessageId = (text, isCreator, timestamp) => {
    // Round timestamp to nearest second to handle slight timing differences
    const roundedTime = Math.floor(timestamp / 1000) * 1000;
    return `${text.trim()}_${isCreator}_${roundedTime}`;
  };

  // PERMANENT FIX: Deduplicate messages using consistent IDs
  const deduplicateMessages = (messages) => {
    const seen = new Map();
    messages.forEach(msg => {
      const msgId = generateMessageId(msg.text, msg.isCreator, msg.timestamp);
      if (!seen.has(msgId) || seen.get(msgId).timestamp < msg.timestamp) {
        seen.set(msgId, msg);
      }
    });
    return Array.from(seen.values()).sort((a, b) => a.timestamp - b.timestamp);
  };

  const saveConversationToStorage = (conversation) => {
    try {
      if (conversation && conversation.id) {
        const storageKey = `conversation_${conversation.id}`;
        const dedupedMessages = deduplicateMessages(conversation.messages || []);
        const dataToSave = {
          id: conversation.id,
          linkId: conversation.linkId,
          messages: dedupedMessages,
          lastMessage: conversation.lastMessage,
          createdAt: conversation.createdAt,
          savedAt: Date.now()
        };
        localStorage.setItem(storageKey, JSON.stringify(dataToSave));
        console.log('💾 Saved:', conversation.id, dedupedMessages.length, 'messages');
      }
    } catch (error) {
      console.error('Error saving conversation:', error);
    }
  };

  const loadConversationFromStorage = (convId) => {
    try {
      const storageKey = `conversation_${convId}`;
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const conversation = JSON.parse(saved);
        conversation.messages = deduplicateMessages(conversation.messages || []);
        console.log('📂 Loaded:', convId, conversation.messages.length, 'messages');
        return conversation;
      }
    } catch (error) {
      console.error('Error loading conversation:', error);
    }
    return null;
  };

  useEffect(() => {
    console.log('🔌 Initializing socket');
    ReactGA.send({ hitType: "pageview", page: window.location.pathname + window.location.search });
    
    socket = io(API_URL, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
      timeout: 10000,
      transports: ['websocket', 'polling']
    });
    
    socket.on('connect', () => {
      console.log('✅ Connected');
      setSocketConnected(true);
      reconnectAttempts.current = 0;
      
      if (pendingMessages.current.length > 0 && activeConvId) {
        console.log('📤 Sending pending messages');
        pendingMessages.current.forEach(msg => {
          socket.emit('send-message', {
            convId: activeConvId,
            message: msg.text,
            isCreator: msg.isCreator
          });
        });
        pendingMessages.current = [];
      }
    });
    
    socket.on('disconnect', (reason) => {
      console.log('⚠️ Disconnected:', reason);
      setSocketConnected(false);
    });
    
    socket.on('reconnect', () => {
      console.log('🔄 Reconnected');
      setSocketConnected(true);
      if (activeConvId) {
        socket.emit('join-conversation', { convId: activeConvId, isCreator });
      }
    });
    
    return () => {
      if (socket) socket.disconnect();
    };
  }, []);

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

  const loadMyLinks = () => {
    try {
      const saved = localStorage.getItem('my_chat_links');
      if (saved) setMyLinks(JSON.parse(saved));
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
        const trimmed = links.slice(0, 10);
        localStorage.setItem('my_chat_links', JSON.stringify(trimmed));
        setMyLinks(trimmed);
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
        socket.emit('join-link', { linkId, creatorId: link.creatorId });
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
    console.log('🔗 Direct link:', linkId);
    const saved = localStorage.getItem('my_chat_history');
    const chatHistory = saved ? JSON.parse(saved) : [];
    
    try {
      const existingChat = chatHistory.find(chat => chat.linkId === linkId);
      
      if (existingChat) {
        console.log('♻️ Restoring:', existingChat.convId);
        
        // Load cached first for instant display
        const cachedConv = loadConversationFromStorage(existingChat.convId);
        
        setActiveConvId(existingChat.convId);
        setIsCreator(false);
        
        if (cachedConv) {
          setCurrentConv(cachedConv);
          setView('chat');
        }
        
        try {
          // Fetch server data
          const response = await axios.get(`${API_URL}/api/conversations/${existingChat.convId}`);
          const { conversation } = response.data;
          
          // Deduplicate ALL messages (cached + server)
          const allMessages = [
            ...(cachedConv?.messages || []),
            ...(conversation.messages || [])
          ];
          const finalMessages = deduplicateMessages(allMessages);
          
          const convData = {
            id: existingChat.convId,
            linkId: conversation.linkId,
            messages: finalMessages,
            createdAt: conversation.createdAt,
            lastMessage: conversation.lastMessage
          };
          
          setCurrentConv(convData);
          setView('chat');
          saveConversationToStorage(convData);
          updateChatHistoryActivity(existingChat.convId);
          
          // Clear processed IDs and rebuild from final messages
          processedMessageIds.current.clear();
          finalMessages.forEach(msg => {
            const msgId = generateMessageId(msg.text, msg.isCreator, msg.timestamp);
            processedMessageIds.current.add(msgId);
          });
          
          setTimeout(() => {
            if (socket && socket.connected) {
              socket.emit('join-conversation', { 
                convId: existingChat.convId, 
                isCreator: false 
              });
            }
          }, 100);
        } catch (error) {
          console.error('Server fetch failed');
          if (!cachedConv) {
            removeChatHistory(existingChat.convId);
            await createNewConversation(linkId);
          }
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
      socket.emit('join-conversation', { convId: conversation.id, isCreator: false });
      processedMessageIds.current.clear();
    } else {
      alert('Invalid or expired link');
      window.history.replaceState({}, '', '/');
      setView('home');
    }
  };

  // PERMANENT FIX: Handle socket messages with deduplication
  useEffect(() => {
    if (!socket) return;

    const handleLoadMessages = ({ messages }) => {
      console.log('📥 Loading', messages?.length || 0, 'messages');
      
      if (activeConvId) {
        setCurrentConv(prev => {
          const existingMessages = prev?.messages || [];
          const serverMessages = messages || [];
          
          // Combine and deduplicate
          const allMessages = [...existingMessages, ...serverMessages];
          const finalMessages = deduplicateMessages(allMessages);
          
          // Update processed IDs
          finalMessages.forEach(msg => {
            const msgId = generateMessageId(msg.text, msg.isCreator, msg.timestamp);
            processedMessageIds.current.add(msgId);
          });
          
          console.log('✅ Final count:', finalMessages.length);
          
          return {
            ...prev,
            id: activeConvId,
            messages: finalMessages
          };
        });
      }
    };

    const handleNewMessage = ({ convId, message: newMessage }) => {
      console.log('📩 New message');
      
      const msgId = generateMessageId(newMessage.text, newMessage.isCreator, newMessage.timestamp);
      
      // Skip if already processed
      if (processedMessageIds.current.has(msgId)) {
        console.log('⏭️ Already processed, skipping');
        return;
      }
      
      const isMessageFromOther = newMessage.isCreator !== isCreator;
      
      if (convId === activeConvId && currentConv) {
        setCurrentConv(prev => {
          const allMessages = [...(prev.messages || []), newMessage];
          const finalMessages = deduplicateMessages(allMessages);
          
          // Mark as processed
          processedMessageIds.current.add(msgId);
          
          const updatedConv = {
            ...prev,
            messages: finalMessages,
            lastMessage: newMessage.timestamp
          };
          
          saveConversationToStorage(updatedConv);
          return updatedConv;
        });
        
        if (isMessageFromOther && !isPageVisible()) {
          playNotificationSound();
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('New Message', {
              body: newMessage.text.substring(0, 50),
              icon: '/favicon.ico'
            });
          }
        }
      }
      
      if (isCreator) {
        setConversations(prev => 
          prev.map(conv => {
            if (conv.id === convId) {
              const isViewingThisChat = (view === 'chat' && activeConvId === convId);
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
    };

    const handleUserTyping = ({ isCreator: typingIsCreator }) => {
      setTypingUser(typingIsCreator ? 'creator' : 'anonymous');
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => setTypingUser(null), 3000);
    };

    const handleUserStopTyping = () => {
      setTypingUser(null);
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    };

    socket.on('load-messages', handleLoadMessages);
    socket.on('new-message', handleNewMessage);
    socket.on('user-typing', handleUserTyping);
    socket.on('user-stop-typing', handleUserStopTyping);

    return () => {
      socket.off('load-messages', handleLoadMessages);
      socket.off('new-message', handleNewMessage);
      socket.off('user-typing', handleUserTyping);
      socket.off('user-stop-typing', handleUserStopTyping);
    };
  }, [currentConv, isCreator, view, activeConvId]);

  useEffect(() => {
    if (!socket || !myLinkId || view !== 'creator') return;

    const handleLoadConversations = ({ conversations: convs }) => {
      const conversationsWithUnread = convs.map(conv => ({
        ...conv,
        unreadCount: calculateUnreadCount(conv)
      }));
      setConversations(conversationsWithUnread);
    };

    const handleNewConversation = ({ conversation }) => {
      setConversations(prev => {
        if (prev.some(c => c.id === conversation.id)) return prev;
        return [...prev, { ...conversation, unreadCount: calculateUnreadCount(conversation) }];
      });
    };

    const handleConversationUpdated = ({ conversation }) => {
      setConversations(prev => {
        const exists = prev.some(c => c.id === conversation.id);
        if (exists) {
          return prev.map(conv => {
            if (conv.id === conversation.id) {
              const isViewingThisChat = (view === 'chat' && activeConvId === conversation.id);
              if (isViewingThisChat) {
                return { ...conv, ...conversation, unreadCount: 0 };
              }
              const oldCount = conv.messages?.length || 0;
              const newCount = conversation.messages?.length || 0;
              if (newCount > oldCount) {
                const newMessages = conversation.messages.slice(oldCount);
                const newUnread = newMessages.filter(msg => !msg.isCreator).length;
                return { ...conv, ...conversation, unreadCount: (conv.unreadCount || 0) + newUnread };
              }
              return { ...conv, ...conversation, unreadCount: conv.unreadCount || 0 };
            }
            return conv;
          });
        }
        return [...prev, { ...conversation, unreadCount: conversation.messages?.filter(m => !m.isCreator).length || 0 }];
      });
    };

    socket.on('load-conversations', handleLoadConversations);
    socket.on('new-conversation', handleNewConversation);
    socket.on('conversation-updated', handleConversationUpdated);

    return () => {
      socket.off('load-conversations');
      socket.off('new-conversation');
      socket.off('conversation-updated');
    };
  }, [socket, myLinkId, view, activeConvId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentConv?.messages]);

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
  }, []);

  useEffect(() => {
    setShowNotification(view === 'home' && !isCreator && myChatHistory.length > 0);
  }, [view, myChatHistory, isCreator]);

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
      socket.emit('join-link', { linkId, creatorId });
      
      const convResponse = await axios.get(`${API_URL}/api/links/${linkId}/conversations`);
      const convs = (convResponse.data.conversations || []).map(conv => ({
        ...conv,
        unreadCount: calculateUnreadCount(conv)
      }));
      setConversations(convs);
      
      ReactGA.event({ category: 'Chat', action: 'Create New Link' });
    } catch (error) {
      alert('Failed to create link');
    } finally {
      setLoading(false);
    }
  };

  const openExistingLink = async (linkId, creatorId) => {
    setLoading(true);
    try {
      const response = await axios.get(`${API_URL}/api/links/${linkId}`);
      if (response.data.link) {
        setMyLinkId(linkId);
        setMyCreatorId(creatorId);
        setIsCreator(true);
        setView('creator');
        window.history.pushState({}, '', `/?creator=${linkId}`);
        socket.emit('join-link', { linkId, creatorId });
        
        const convResponse = await axios.get(`${API_URL}/api/links/${linkId}/conversations`);
        const convs = (convResponse.data.conversations || []).map(conv => ({
          ...conv,
          unreadCount: calculateUnreadCount(conv)
        }));
        setConversations(convs);
      }
    } catch (error) {
      alert('Link no longer exists');
      removeMyLink(linkId);
    } finally {
      setLoading(false);
    }
  };

  const joinWithLink = () => {
    if (!joinLinkId.trim()) {
      alert('Please enter a link ID');
      return;
    }
    ReactGA.event({ category: 'Chat', action: 'Join with Link' });
    window.location.href = `/?link=${joinLinkId}`;
  };

  const openConversation = async (convId) => {
    setLoading(true);
    try {
      const cachedConv = loadConversationFromStorage(convId);
      if (cachedConv) {
        setActiveConvId(convId);
        setCurrentConv(cachedConv);
        setView('chat');
      }
      
      const response = await axios.get(`${API_URL}/api/conversations/${convId}`);
      const { conversation } = response.data;
      
      const allMessages = [...(cachedConv?.messages || []), ...(conversation.messages || [])];
      const finalMessages = deduplicateMessages(allMessages);
      
      const convData = { ...conversation, messages: finalMessages };
      
      setActiveConvId(convId);
      setCurrentConv(convData);
      setView('chat');
      saveConversationToStorage(convData);
      
      // Rebuild processed IDs
      processedMessageIds.current.clear();
      finalMessages.forEach(msg => {
        const msgId = generateMessageId(msg.text, msg.isCreator, msg.timestamp);
        processedMessageIds.current.add(msgId);
      });
      
      setConversations(prev => 
        prev.map(conv => {
          if (conv.id === convId) {
            saveReadStatus(convId, finalMessages.length);
            return { ...conv, unreadCount: 0, lastReadTime: Date.now() };
          }
          return conv;
        })
      );
      
      socket.emit('join-conversation', { convId, isCreator: true });
    } catch (error) {
      const cachedConv = loadConversationFromStorage(convId);
      if (cachedConv) {
        setActiveConvId(convId);
        setCurrentConv(cachedConv);
        setView('chat');
      } else {
        alert('Failed to open conversation');
      }
    } finally {
      setLoading(false);
    }
  };

  const loadMyChatHistory = () => {
    return new Promise((resolve) => {
      try {
        const saved = localStorage.getItem('my_chat_history');
        const history = saved ? JSON.parse(saved) : [];
        setMyChatHistory(history);
        resolve(history);
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
        history[existingIndex] = { ...history[existingIndex], convId, lastActive: Date.now() };
      } else {
        history.unshift({ linkId, convId, joinedAt: Date.now(), lastActive: Date.now() });
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
        const updated = history.map(h => h.convId === convId ? { ...h, lastActive: Date.now() } : h);
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

  const returnToActiveChat = () => {
    if (myChatHistory.length > 0) {
      window.location.href = `/?link=${myChatHistory[0].linkId}`;
    }
  };

  const sendMessageHandler = () => {
    if (!message.trim() || !activeConvId) return;
    
    const messageText = message.trim();
    const tempMessage = {
      id: `temp_${Date.now()}`,
      text: messageText,
      timestamp: Date.now(),
      isCreator: isCreator,
      pending: !socketConnected
    };
    
    // Generate ID and mark as processed immediately
    const msgId = generateMessageId(tempMessage.text, tempMessage.isCreator, tempMessage.timestamp);
    processedMessageIds.current.add(msgId);
    
    setCurrentConv(prev => {
      const allMessages = [...(prev.messages || []), tempMessage];
      const finalMessages = deduplicateMessages(allMessages);
      const updatedConv = { ...prev, messages: finalMessages, lastMessage: tempMessage.timestamp };
      saveConversationToStorage(updatedConv);
      return updatedConv;
    });
    
    setMessage('');
    
    if (socket && socket.connected) {
      socket.emit('send-message', { convId: activeConvId, message: messageText, isCreator });
      socket.emit('stop-typing', { convId: activeConvId });
    } else {
      pendingMessages.current.push({ text: messageText, isCreator });
    }
    
    ReactGA.event({ category: 'Chat', action: 'Send Message' });
    
    if (!isCreator) {
      updateChatHistoryActivity(activeConvId);
    }
  };

  const handleTyping = () => {
    if (!activeConvId || !socket) return;
    socket.emit('typing', { convId: activeConvId, isCreator });
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => {
      if (socket) socket.emit('stop-typing', { convId: activeConvId });
    }, 1000);
  };

  const copyLink = () => {
    const fullLink = `${window.location.origin}/?link=${myLinkId}`;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(fullLink)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
          ReactGA.event({ category: 'Chat', action: 'Copy Link' });
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
          <h1 className="title">Anonymous Chat</h1>
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
                        <div className="my-link-date">Created {formatTime(link.createdAt)}</div>
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
            <p className="feature"><a href="https://ochat.fun/about.html">📃 More about Ochat</a></p>
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
            <button onClick={goBack} className="back-button">Home</button>
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
            <button onClick={goBack} className="back-button-small">←</button>
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
              <span>⚠️ Connection lost. Messages will send when reconnected.</span>
              <button onClick={() => socket?.connect()} className="reconnect-btn">
                Retry Now
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
                  key={`${msg.timestamp}_${idx}`}
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
              placeholder={socketConnected ? "Type a message..." : "Offline - messages will send when reconnected"}
              className="message-input"
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                handleTyping();
              }}
              onKeyPress={(e) => e.key === 'Enter' && sendMessageHandler()}
            />
            <button
              onClick={sendMessageHandler}
              className="send-button"
              disabled={!message.trim()}
              title={socketConnected ? "Send message" : "Send when reconnected"}
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