// src/App.js - FIXED: No duplicate messages on reload
import React, { useState, useEffect, useRef } from 'react';
import { MessageCircle, Send, Copy, Check, Plus, User, List } from 'lucide-react';
import io from 'socket.io-client';
import axios from 'axios';
import ReactGA from 'react-ga4';
import './app.css';

// Initialize Google Analytics
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
  const hasLoadedMessages = useRef(false); // NEW: Track if we've loaded messages

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

  // IMPROVED: Better deduplication with unique message IDs
  const deduplicateMessages = (messages) => {
    const seen = new Set();
    return messages.filter(msg => {
      // Create unique key: text + sender + timestamp (rounded to second)
      const key = `${msg.text}|${msg.isCreator}|${Math.floor(msg.timestamp / 1000)}`;
      if (seen.has(key)) {
        return false; // Duplicate
      }
      seen.add(key);
      return true;
    }).sort((a, b) => a.timestamp - b.timestamp);
  };

  // Save conversation to localStorage
  const saveConversationToStorage = (conversation) => {
    try {
      if (conversation && conversation.id) {
        const storageKey = `conversation_${conversation.id}`;
        const dataToSave = {
          id: conversation.id,
          linkId: conversation.linkId,
          messages: conversation.messages || [],
          lastMessage: conversation.lastMessage,
          createdAt: conversation.createdAt,
          savedAt: Date.now(),
          version: 1
        };
        localStorage.setItem(storageKey, JSON.stringify(dataToSave));
        console.log('💾 Saved conversation:', conversation.id, 'Messages:', dataToSave.messages.length);
      }
    } catch (error) {
      console.error('Error saving conversation:', error);
    }
  };

  // Load conversation from localStorage
  const loadConversationFromStorage = (convId) => {
    try {
      const storageKey = `conversation_${convId}`;
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const conversation = JSON.parse(saved);
        console.log('📂 Loaded from cache:', convId, 'Messages:', conversation.messages?.length || 0);
        return conversation;
      }
    } catch (error) {
      console.error('Error loading conversation:', error);
    }
    return null;
  };

  // Initialize socket
  useEffect(() => {
    console.log('🔌 Initializing socket connection');
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
      console.log('✅ Connected:', socket.id);
      setSocketConnected(true);
      reconnectAttempts.current = 0;
      
      if (pendingMessages.current.length > 0 && activeConvId) {
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
      reconnectAttempts.current++;
    });
    
    socket.on('reconnect', (attemptNumber) => {
      console.log('🔄 Reconnected after', attemptNumber, 'attempts');
      setSocketConnected(true);
      reconnectAttempts.current = 0;
      
      if (activeConvId) {
        socket.emit('join-conversation', { convId: activeConvId, isCreator });
      }
    });
    
    return () => {
      if (socket) socket.disconnect();
    };
  }, []);

  // Check for saved session or direct link
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
      if (saved) {
        const links = JSON.parse(saved);
        setMyLinks(links);
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

  // FIXED: Handle direct link without duplicates
  const handleDirectLink = async (linkId) => {
    console.log('🔗 Handling direct link:', linkId);
    hasLoadedMessages.current = false; // Reset flag
    
    const saved = localStorage.getItem('my_chat_history');
    const chatHistory = saved ? JSON.parse(saved) : [];
    
    try {
      const existingChat = chatHistory.find(chat => chat.linkId === linkId);
      
      if (existingChat) {
        console.log('♻️ Restoring conversation:', existingChat.convId);
        
        // Load from cache FIRST
        const cachedConv = loadConversationFromStorage(existingChat.convId);
        
        setActiveConvId(existingChat.convId);
        setIsCreator(false);
        
        if (cachedConv && cachedConv.messages && cachedConv.messages.length > 0) {
          // Show cached messages immediately
          setCurrentConv(cachedConv);
          setView('chat');
          hasLoadedMessages.current = true; // Mark as loaded
        }
        
        // Join socket room BEFORE fetching from server
        setTimeout(() => {
          if (socket && socket.connected) {
            console.log('🔌 Joining conversation room:', existingChat.convId);
            socket.emit('join-conversation', { 
              convId: existingChat.convId, 
              isCreator: false 
            });
          }
        }, 100);
        
        // Fetch from server for updates
        try {
          const response = await axios.get(`${API_URL}/api/conversations/${existingChat.convId}`);
          const { conversation } = response.data;
          
          // Only merge if server has MORE messages than cache
          if (cachedConv && cachedConv.messages) {
            const cachedCount = cachedConv.messages.length;
            const serverCount = conversation.messages?.length || 0;
            
            if (serverCount > cachedCount) {
              console.log('📥 Server has new messages, merging...');
              const allMessages = [...cachedConv.messages, ...conversation.messages];
              const mergedMessages = deduplicateMessages(allMessages);
              
              const convData = {
                id: existingChat.convId,
                linkId: conversation.linkId,
                messages: mergedMessages,
                createdAt: conversation.createdAt,
                lastMessage: conversation.lastMessage
              };
              
              setCurrentConv(convData);
              saveConversationToStorage(convData);
            }
          } else {
            // No cache, use server data
            const convData = {
              id: existingChat.convId,
              linkId: conversation.linkId,
              messages: conversation.messages || [],
              createdAt: conversation.createdAt,
              lastMessage: conversation.lastMessage
            };
            setCurrentConv(convData);
            setView('chat');
            saveConversationToStorage(convData);
            hasLoadedMessages.current = true;
          }
          
          updateChatHistoryActivity(existingChat.convId);
        } catch (error) {
          console.error('❌ Server fetch failed, using cache');
          if (!cachedConv) {
            removeChatHistory(existingChat.convId);
            await createNewConversation(linkId);
          }
        }
      } else {
        await createNewConversation(linkId);
      }
    } catch (error) {
      console.error('❌ Error in handleDirectLink:', error);
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
      hasLoadedMessages.current = true;
      
      saveChatHistory(linkId, conversation.id);
      socket.emit('join-conversation', { convId: conversation.id, isCreator: false });
      
      console.log('✅ Created new conversation:', conversation.id);
    } else {
      alert('Invalid or expired link');
      window.history.replaceState({}, '', '/');
      setView('home');
    }
  };

  // FIXED: Socket message handling - no duplicates
  useEffect(() => {
    if (!socket) return;

    const handleLoadMessages = ({ messages }) => {
      console.log('📥 Socket load-messages:', messages?.length || 0);
      
      // IMPORTANT: Only load from socket if we haven't already loaded from cache
      if (hasLoadedMessages.current) {
        console.log('⏭️ Skipping socket load - already have messages from cache');
        return;
      }
      
      if (activeConvId && messages && messages.length > 0) {
        setCurrentConv(prev => ({
          ...prev,
          id: activeConvId,
          messages: deduplicateMessages(messages)
        }));
        hasLoadedMessages.current = true;
      }
    };

    const handleNewMessage = ({ convId, message: newMessage }) => {
      console.log('📩 New message:', convId, newMessage.text.substring(0, 20));
      
      const isMessageFromOther = newMessage.isCreator !== isCreator;
      
      if (convId === activeConvId && currentConv) {
        setCurrentConv(prev => {
          // Remove pending/optimistic messages that match
          const filteredMessages = (prev.messages || []).filter(msg => 
            !(msg.isOptimistic && msg.text === newMessage.text && msg.isCreator === newMessage.isCreator)
          );
          
          // Check if message already exists
          const exists = filteredMessages.some(msg => 
            msg.text === newMessage.text && 
            msg.isCreator === newMessage.isCreator &&
            Math.abs(msg.timestamp - newMessage.timestamp) < 2000
          );
          
          if (exists) {
            console.log('⏭️ Message already exists, skipping');
            return prev;
          }
          
          const updatedMessages = deduplicateMessages([...filteredMessages, newMessage]);
          const updatedConv = {
            ...prev,
            messages: updatedMessages,
            lastMessage: newMessage.timestamp
          };
          
          saveConversationToStorage(updatedConv);
          return updatedConv;
        });
        
        if (isMessageFromOther && !isPageVisible()) {
          playNotificationSound();
        }
      }
      
      if (isCreator) {
        setConversations(prev => 
          prev.map(conv => {
            if (conv.id === convId) {
              const isViewingThisChat = (view === 'chat' && activeConvId === convId);
              const shouldIncrementUnread = !newMessage.isCreator && !isViewingThisChat;
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

  // Load conversations for creator
  useEffect(() => {
    if (!socket || !myLinkId || view !== 'creator') return;

    const handleLoadConversations = ({ conversations: convs }) => {
      const conversationsWithUnread = convs.map(conv => ({
        ...conv,
        unreadCount: calculateUnreadCount(conv)
      }));
      setConversations(conversationsWithUnread || []);
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
              return { ...conv, ...conversation };
            }
            return conv;
          });
        }
        return [...prev, { ...conversation, unreadCount: calculateUnreadCount(conversation) }];
      });
    };

    socket.on('load-conversations', handleLoadConversations);
    socket.on('new-conversation', handleNewConversation);
    socket.on('conversation-updated', handleConversationUpdated);

    return () => {
      socket.off('load-conversations', handleLoadConversations);
      socket.off('new-conversation', handleNewConversation);
      socket.off('conversation-updated', handleConversationUpdated);
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
    if (view === 'home' && !isCreator) {
      setShowNotification(myChatHistory.length > 0);
    } else {
      setShowNotification(false);
    }
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
      const convs = convResponse.data.conversations || [];
      setConversations(convs.map(conv => ({ ...conv, unreadCount: calculateUnreadCount(conv) })));
      
      ReactGA.event({ category: 'Chat', action: 'Create New Link', label: 'Creator' });
    } catch (error) {
      console.error('Error creating link:', error);
      alert('Failed to create link');
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
        socket.emit('join-link', { linkId, creatorId });
        
        const convResponse = await axios.get(`${API_URL}/api/links/${linkId}/conversations`);
        const convs = convResponse.data.conversations || [];
        setConversations(convs.map(conv => ({ ...conv, unreadCount: calculateUnreadCount(conv) })));
      }
    } catch (error) {
      console.error('Error opening link:', error);
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
    ReactGA.event({ category: 'Chat', action: 'Join with Link', label: 'Anonymous User' });
    window.location.href = `/?link=${joinLinkId}`;
  };

  const openConversation = async (convId) => {
    setLoading(true);
    hasLoadedMessages.current = false; // Reset flag
    try {
      const cachedConv = loadConversationFromStorage(convId);
      if (cachedConv) {
        setActiveConvId(convId);
        setCurrentConv(cachedConv);
        setView('chat');
        hasLoadedMessages.current = true;
      }
      
      const response = await axios.get(`${API_URL}/api/conversations/${convId}`);
      const { conversation } = response.data;
      
      const cachedMessages = cachedConv?.messages || [];
      const serverMessages = conversation.messages || [];
      const allMessages = [...cachedMessages, ...serverMessages];
      const mergedMessages = deduplicateMessages(allMessages);
      
      const updatedConv = { ...conversation, messages: mergedMessages };
      
      setActiveConvId(convId);
      setCurrentConv(updatedConv);
      setView('chat');
      saveConversationToStorage(updatedConv);
      
      setConversations(prev => 
        prev.map(conv => {
          if (conv.id === convId) {
            saveReadStatus(convId, mergedMessages.length);
            return { ...conv, unreadCount: 0, lastReadTime: Date.now() };
          }
          return conv;
        })
      );
      
      socket.emit('join-conversation', { convId, isCreator: true });
    } catch (error) {
      console.error('Error opening conversation:', error);
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

  const returnToActiveChat = async () => {
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
      isOptimistic: true
    };
    
    // Add optimistic message to UI
    setCurrentConv(prev => {
      const updatedConv = {
        ...prev,
        messages: [...(prev.messages || []), tempMessage],
        lastMessage: tempMessage.timestamp
      };
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
    
    ReactGA.event({ category: 'Chat', action: 'Send Message', label: isCreator ? 'Creator' : 'Anonymous User' });
    
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
          ReactGA.event({ category: 'Chat', action: 'Copy Link', label: 'Share Link' });
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
      hasLoadedMessages.current = false;
      window.history.pushState({}, '', `/?creator=${myLinkId}`);
    } else {
      setView('home');
      setMyLinkId(null);
      setMyCreatorId(null);
      setActiveConvId(null);
      setConversations([]);
      setCurrentConv(null);
      setIsCreator(false);
      hasLoadedMessages.current = false;
      window.history.pushState({}, '', '/');
    }
  };

  const viewConversationList = () => {
    if (myLinkId) {
      setView('creator');
      setActiveConvId(null);
      setCurrentConv(null);
      hasLoadedMessages.current = false;
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
            <button onClick={returnToActiveChat} className="active-chat-button" title="Return to active chat" />
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
          <button onClick={joinWithLink} className="secondary-button">Join Chat</button>
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
                      <button onClick={() => openExistingLink(link.linkId, link.creatorId)} className="my-link-open-btn">
                        Open
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); removeMyLink(link.linkId); }} className="my-link-delete-btn" title="Remove from list">
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
              <p className="header-subtitle">{conversations.length} conversation{conversations.length !== 1 ? 's' : ''}</p>
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
                <div key={conv.id} className="conversation-item" onClick={() => openConversation(conv.id)}>
                  <div className="avatar">
                    <User size={24} color="#667eea" />
                  </div>
                  <div className="conv-info">
                    <div className="conv-header">
                      <span className="conv-name">Anonymous User</span>
                      <span className="conv-time">{formatTime(conv.lastMessage || conv.createdAt)}</span>
                    </div>
                    <p className="last-message">
                      {conv.messages && conv.messages.length > 0
                        ? conv.messages[conv.messages.length - 1].text
                        : 'No messages yet'}
                    </p>
                  </div>
                  {conv.unreadCount > 0 && <div className="unread-badge">{conv.unreadCount}</div>}
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
                <h3 className="chat-title">{isCreator ? 'Anonymous User' : 'Chat Creator'}</h3>
                {socketConnected && <p className="chat-status">● Online</p>}
              </div>
            </div>
          </div>
          {!socketConnected && (
            <div className="connection-warning">
              <span>⚠️ Connection lost. Messages will send when reconnected.</span>
              <button onClick={() => socket?.connect()} className="reconnect-btn">Retry Now</button>
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
                <div key={idx} className="message-wrapper" style={{ justifyContent: msg.isCreator === isCreator ? 'flex-end' : 'flex-start' }}>
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
              onChange={(e) => { setMessage(e.target.value); handleTyping(); }}
              onKeyPress={(e) => e.key === 'Enter' && sendMessageHandler()}
            />
            <button onClick={sendMessageHandler} className="send-button" disabled={!message.trim()} title={socketConnected ? "Send message" : "Send when reconnected"}>
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