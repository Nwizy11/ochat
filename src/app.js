// src/App.js - Fixed version with no flash and better notification UI
import React, { useState, useEffect, useRef } from 'react';
import { MessageCircle, Send, Copy, Check, Plus, User, List, Bell } from 'lucide-react';
import io from 'socket.io-client';
import axios from 'axios';
import ReactGA from 'react-ga4';
import './app.css';

// Initialize Google Analytics
const TRACKING_ID = 'G-FE98DD5ZS8'; // Replace with your GA4 Measurement ID
ReactGA.initialize(TRACKING_ID);

const API_URL = "https://anonym-backend.onrender.com";
let socket;

function App() {
  const [view, setView] = useState('loading'); // Start with loading state
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
  const lastMessageCountRef = useRef(0);

  // Initialize audio context for notification sound
  useEffect(() => {
    // Create audio context (modern way to generate sounds)
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
      
      // Create a pleasant notification sound (two-tone)
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

  // Check if page is visible
  const isPageVisible = () => {
    return document.visibilityState === 'visible';
  };

  // Helper functions for read status and unread count - DEFINED EARLY
  const getReadStatus = (convId) => {
    try {
      const readStatus = JSON.parse(localStorage.getItem('chat_read_status') || '{}');
      return readStatus[convId] || null;
    } catch (error) {
      console.error('Error getting read status:', error);
      return null;
    }
  };

  const calculateUnreadCount = (conv) => {
    const readStatus = getReadStatus(conv.id);
    if (!readStatus) {
      return conv.messages ? conv.messages.filter(m => !m.isCreator).length : 0;
    }
    
    const totalMessages = conv.messages?.length || 0;
    if (totalMessages <= readStatus.readUpToMessageCount) {
      return 0;
    }
    
    const newMessages = conv.messages.slice(readStatus.readUpToMessageCount);
    return newMessages.filter(m => !m.isCreator).length;
  };

  // Initialize socket connection
  useEffect(() => {
    console.log('🔌 Initializing socket connection to:', API_URL);
    
    // Track page view on mount
    ReactGA.send({ hitType: "pageview", page: window.location.pathname + window.location.search });
    
    socket = io(API_URL, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 10,
      transports: ['websocket', 'polling']
    });
    
    socket.on('connect', () => {
      console.log('✅ Connected to server, socket ID:', socket.id);
      setSocketConnected(true);
    });
    
    socket.on('disconnect', () => {
      console.log('⚠️ Disconnected from server');
      setSocketConnected(false);
    });
    
    socket.on('connect_error', (error) => {
      console.error('❌ Connection error:', error.message);
      setSocketConnected(false);
    });
    
    socket.on('reconnect', (attemptNumber) => {
      console.log('🔄 Reconnected after', attemptNumber, 'attempts');
      setSocketConnected(true);
      
      if (activeConvId) {
        console.log('♻️ Rejoining conversation:', activeConvId);
        socket.emit('join-conversation', { 
          convId: activeConvId, 
          isCreator 
        });
      }
    });
    
    socket.on('error', (error) => {
      console.error('🔴 Socket error:', error);
    });
    
    return () => {
      if (socket) {
        console.log('🔌 Disconnecting socket');
        socket.disconnect();
      }
    };
  }, []);

  // Check for saved creator session or direct link on mount
  useEffect(() => {
    const initializeApp = async () => {
      // Check URL parameters FIRST before loading anything
      const urlParams = new URLSearchParams(window.location.search);
      const linkParam = urlParams.get('link');
      const creatorParam = urlParams.get('creator');
      
      // Load saved data
      loadMyLinks();
      await loadMyChatHistory();
      
      if (creatorParam) {
        console.log('🔄 Restoring creator session:', creatorParam);
        await restoreCreatorSession(creatorParam);
      } else if (linkParam) {
        console.log('📎 Direct link detected:', linkParam);
        await handleDirectLink(linkParam);
      } else {
        // No active session, go to home
        setView('home');
      }
    };
    
    initializeApp();
  }, []);

  // Load my links from localStorage
  const loadMyLinks = () => {
    try {
      const saved = localStorage.getItem('my_chat_links');
      console.log('📚 Raw localStorage data:', saved);
      if (saved) {
        const links = JSON.parse(saved);
        setMyLinks(links);
        console.log('📚 Loaded saved links:', links.length, links);
      } else {
        console.log('📚 No saved links found');
      }
    } catch (error) {
      console.error('Error loading links:', error);
    }
  };

  // Save link to localStorage
  const saveMyLink = (linkId, creatorId) => {
    try {
      const saved = localStorage.getItem('my_chat_links');
      const links = saved ? JSON.parse(saved) : [];
      
      if (!links.some(l => l.linkId === linkId)) {
        links.unshift({
          linkId,
          creatorId,
          createdAt: Date.now()
        });
        
        const trimmedLinks = links.slice(0, 10);
        localStorage.setItem('my_chat_links', JSON.stringify(trimmedLinks));
        setMyLinks(trimmedLinks);
        console.log('💾 Saved link:', linkId);
      }
    } catch (error) {
      console.error('Error saving link:', error);
    }
  };

  // Remove link from localStorage
  const removeMyLink = (linkId) => {
    try {
      const saved = localStorage.getItem('my_chat_links');
      if (saved) {
        const links = JSON.parse(saved);
        const filtered = links.filter(l => l.linkId !== linkId);
        localStorage.setItem('my_chat_links', JSON.stringify(filtered));
        setMyLinks(filtered);
        console.log('🗑️ Removed link:', linkId);
      }
    } catch (error) {
      console.error('Error removing link:', error);
    }
  };

  // Restore creator session from URL
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
        
        console.log('✅ Creator session restored');
      }
    } catch (error) {
      console.error('Error restoring session:', error);
      window.history.replaceState({}, '', '/');
      setView('home');
    }
  };

  // Handle direct link access
  const handleDirectLink = async (linkId) => {
    console.log('🔗 Handling direct link:', linkId);
    
    const saved = localStorage.getItem('my_chat_history');
    const chatHistory = saved ? JSON.parse(saved) : [];
    console.log('📚 Current chat history:', chatHistory);
    
    try {
      const existingChat = chatHistory.find(chat => chat.linkId === linkId);
      console.log('🔍 Existing chat found:', existingChat);
      
      if (existingChat) {
        console.log('♻️ Restoring conversation:', existingChat.convId);
        
        try {
          const response = await axios.get(`${API_URL}/api/conversations/${existingChat.convId}`);
          const { conversation } = response.data;
          
          console.log('📦 Server returned conversation:', conversation);
          
          setActiveConvId(existingChat.convId);
          setIsCreator(false);
          
          const convData = {
            id: existingChat.convId,
            linkId: conversation.linkId,
            messages: conversation.messages || [],
            createdAt: conversation.createdAt,
            lastMessage: conversation.lastMessage
          };
          
          setCurrentConv(convData);
          setView('chat');
          
          updateChatHistoryActivity(existingChat.convId);
          
          setTimeout(() => {
            if (socket && socket.connected) {
              console.log('🔌 Joining conversation room:', existingChat.convId);
              socket.emit('join-conversation', { 
                convId: existingChat.convId, 
                isCreator: false 
              });
            }
          }, 100);
          
        } catch (error) {
          console.error('❌ Failed to restore conversation:', error);
          removeChatHistory(existingChat.convId);
          await createNewConversation(linkId);
        }
      } else {
        console.log('🆕 No existing chat, creating new conversation');
        await createNewConversation(linkId);
      }
    } catch (error) {
      console.error('❌ Error in handleDirectLink:', error);
      alert('Invalid link or server error');
      window.history.replaceState({}, '', '/');
      setView('home');
    }
  };

  // Create new conversation helper
  const createNewConversation = async (linkId) => {
    const verifyResponse = await axios.get(`${API_URL}/api/links/${linkId}/verify`);
    
    if (verifyResponse.data.exists) {
      const response = await axios.post(`${API_URL}/api/conversations/create`, {
        linkId: linkId
      });
      
      const { conversation } = response.data;
      
      setActiveConvId(conversation.id);
      setCurrentConv(conversation);
      setIsCreator(false);
      setView('chat');
      
      saveChatHistory(linkId, conversation.id);
      
      socket.emit('join-conversation', { 
        convId: conversation.id, 
        isCreator: false 
      });
      
      console.log('✅ Created new conversation:', conversation.id);
    } else {
      alert('Invalid or expired link');
      window.history.replaceState({}, '', '/');
      setView('home');
    }
  };

  // Load messages for current conversation with real-time updates
  useEffect(() => {
    if (!socket) return;

    const handleLoadMessages = ({ messages }) => {
      console.log('📥 Socket: Loading messages:', messages?.length || 0, messages);
      
      if (activeConvId) {
        setCurrentConv(prev => {
          const updated = {
            ...prev,
            id: activeConvId,
            messages: messages || []
          };
          console.log('💾 Updated currentConv:', updated);
          return updated;
        });
      }
    };

    const handleNewMessage = ({ convId, message: newMessage }) => {
      console.log('📩 New message received:', {
        convId,
        activeConvId,
        message: newMessage,
        isForThisConv: convId === activeConvId
      });
      
      // Check if this is a message from the other person
      const isMessageFromOther = newMessage.isCreator !== isCreator;
      
      if (convId === activeConvId && currentConv) {
        // Only add the message if it's from the other person
        // (we already added our own messages optimistically)
        if (isMessageFromOther) {
          setCurrentConv(prev => {
            const updatedConv = {
              ...prev,
              messages: [...(prev.messages || []), newMessage],
              lastMessage: newMessage.timestamp
            };
            console.log('💾 Updated conversation with new message:', updatedConv.messages.length);
            return updatedConv;
          });
          
          // Play sound if message is from other person and page is not visible
          if (!isPageVisible()) {
            console.log('🔔 Playing notification sound - page not visible');
            playNotificationSound();
            
            // Show browser notification if permission granted
            if ('Notification' in window && Notification.permission === 'granted') {
              new Notification('New Message', {
                body: newMessage.text.substring(0, 50) + (newMessage.text.length > 50 ? '...' : ''),
                icon: '/favicon.ico',
                tag: 'chat-message',
                requireInteraction: false
              });
            }
          }
        }
      }
      
      if (isCreator) {
        setConversations(prev => 
          prev.map(conv => {
            if (conv.id === convId) {
              const isViewingThisChat = (view === 'chat' && activeConvId === convId);
              const shouldIncrementUnread = !newMessage.isCreator && !isViewingThisChat;
              const newUnreadCount = shouldIncrementUnread 
                ? (conv.unreadCount || 0) + 1 
                : (conv.unreadCount || 0);
              
              // Play sound if not viewing this chat and message is from anonymous user
              if (shouldIncrementUnread && !isPageVisible()) {
                console.log('🔔 Playing notification sound for creator - new conversation message');
                playNotificationSound();
              }
              
              return {
                ...conv,
                messages: [...(conv.messages || []), newMessage],
                lastMessage: newMessage.timestamp,
                unreadCount: newUnreadCount
              };
            }
            return conv;
          })
        );
      }
    };

    const handleUserTyping = ({ isCreator: typingIsCreator }) => {
      setTypingUser(typingIsCreator ? 'creator' : 'anonymous');
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
      typingTimeoutRef.current = setTimeout(() => setTypingUser(null), 3000);
    };

    const handleUserStopTyping = () => {
      setTypingUser(null);
      if (typingTimeoutRef.current) {
        clearTimeout(typingTimeoutRef.current);
      }
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

  // Load conversations for creator with real-time updates
  useEffect(() => {
    if (!socket || !myLinkId || view !== 'creator') return;

    const handleLoadConversations = ({ conversations: convs }) => {
      console.log('📋 Loaded conversations:', convs.length);
      const conversationsWithUnread = convs.map(conv => {
        const unreadCount = calculateUnreadCount(conv);
        return {
          ...conv,
          unreadCount
        };
      });
      setConversations(conversationsWithUnread || []);
    };

    const handleNewConversation = ({ conversation }) => {
      console.log('🆕 New conversation added:', conversation.id);
      setConversations(prev => {
        const exists = prev.some(c => c.id === conversation.id);
        if (exists) return prev;
        
        const unreadCount = calculateUnreadCount(conversation);
        
        return [...prev, { 
          ...conversation, 
          unreadCount 
        }];
      });
    };

    const handleConversationUpdated = ({ conversation }) => {
      console.log('🔄 Conversation updated:', conversation.id);
      setConversations(prev => {
        const exists = prev.some(c => c.id === conversation.id);
        if (exists) {
          return prev.map(conv => {
            if (conv.id === conversation.id) {
              const isViewingThisChat = (view === 'chat' && activeConvId === conversation.id);
              
              if (isViewingThisChat) {
                return {
                  ...conv,
                  ...conversation,
                  unreadCount: 0
                };
              }
              
              const oldMessageCount = conv.messages?.length || 0;
              const newMessageCount = conversation.messages?.length || 0;
              
              if (newMessageCount > oldMessageCount) {
                const newMessages = conversation.messages.slice(oldMessageCount);
                const newUnreadCount = newMessages.filter(msg => !msg.isCreator).length;
                const totalUnread = (conv.unreadCount || 0) + newUnreadCount;
                
                return {
                  ...conv,
                  ...conversation,
                  unreadCount: totalUnread
                };
              }
              
              return {
                ...conv,
                ...conversation,
                unreadCount: conv.unreadCount || 0
              };
            }
            return conv;
          });
        } else {
          const unreadCount = conversation.messages 
            ? conversation.messages.filter(msg => !msg.isCreator).length 
            : 0;
          
          return [...prev, { 
            ...conversation, 
            unreadCount 
          }];
        }
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
  }, [socket, myLinkId, view, activeConvId, calculateUnreadCount]);

  // Auto scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentConv?.messages]);

  // Request notification permission on mount
  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then(permission => {
        console.log('🔔 Notification permission:', permission);
      });
    }
  }, []);

  // Check if user has active chat and show notification
  useEffect(() => {
    if (view === 'home' && !isCreator) {
      const hasActiveChat = myChatHistory.length > 0;
      setShowNotification(hasActiveChat);
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
      
      const convsWithUnread = convs.map(conv => {
        const unreadCount = calculateUnreadCount(conv);
        return {
          ...conv,
          unreadCount
        };
      });
      
      setConversations(convsWithUnread);
      
      // Track event
      ReactGA.event({
        category: 'Chat',
        action: 'Create New Link',
        label: 'Creator'
      });
      
      console.log('✅ Chat link created');
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
        
        socket.emit('join-link', { linkId, creatorId });
        
        const convResponse = await axios.get(`${API_URL}/api/links/${linkId}/conversations`);
        const convs = convResponse.data.conversations || [];
        
        const convsWithUnread = convs.map(conv => {
          const unreadCount = calculateUnreadCount(conv);
          return {
            ...conv,
            unreadCount
          };
        });
        
        setConversations(convsWithUnread);
        
        console.log('✅ Opened existing link:', linkId);
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
    
    // Track event
    ReactGA.event({
      category: 'Chat',
      action: 'Join with Link',
      label: 'Anonymous User'
    });
    
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
            
            return {
              ...conv,
              unreadCount: 0,
              lastReadTime: Date.now()
            };
          }
          return conv;
        })
      );
      
      socket.emit('join-conversation', { 
        convId, 
        isCreator: true 
      });
      
      console.log('✅ Opened conversation:', convId);
    } catch (error) {
      console.error('Error opening conversation:', error);
      alert('Failed to open conversation');
    } finally {
      setLoading(false);
    }
  };

  const saveReadStatus = (convId, readUpToMessageCount) => {
    try {
      const readStatus = JSON.parse(localStorage.getItem('chat_read_status') || '{}');
      readStatus[convId] = {
        readUpToMessageCount,
        timestamp: Date.now()
      };
      localStorage.setItem('chat_read_status', JSON.stringify(readStatus));
    } catch (error) {
      console.error('Error saving read status:', error);
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
        console.error('Error loading chat history:', error);
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
          convId: convId,
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

  const sendMessageHandler = () => {
    if (!message.trim() || !activeConvId || !socket || !socket.connected) {
      return;
    }
    
    const messageText = message.trim();
    const tempMessage = {
      text: messageText,
      timestamp: Date.now(),
      isCreator: isCreator
    };
    
    // Immediately add message to UI (optimistic update)
    setCurrentConv(prev => ({
      ...prev,
      messages: [...(prev.messages || []), tempMessage],
      lastMessage: tempMessage.timestamp
    }));
    
    setMessage('');
    
    socket.emit('send-message', {
      convId: activeConvId,
      message: messageText,
      isCreator
    });
    
    socket.emit('stop-typing', { convId: activeConvId });
    
    // Track message sent
    ReactGA.event({
      category: 'Chat',
      action: 'Send Message',
      label: isCreator ? 'Creator' : 'Anonymous User'
    });
    
    if (!isCreator) {
      updateChatHistoryActivity(activeConvId);
    }
  };

  const handleTyping = () => {
    if (!activeConvId || !socket) return;
    
    socket.emit('typing', { convId: activeConvId, isCreator });
    
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }
    typingTimeoutRef.current = setTimeout(() => {
      if (socket) {
        socket.emit('stop-typing', { convId: activeConvId });
      }
    }, 1000);
  };

  const copyLink = () => {
    const fullLink = `${window.location.origin}/?link=${myLinkId}`;
    
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(fullLink)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
          
          // Track link copy
          ReactGA.event({
            category: 'Chat',
            action: 'Copy Link',
            label: 'Share Link'
          });
        })
        .catch(() => {
          copyToClipboardFallback(fullLink);
        });
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

  // Loading state
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

  // Home View
  if (view === 'home') {
    return (
      <div className="container">
        <div className="home-card">
          {/* Active Chat Notification Button - Top Right */}
          {showNotification && myChatHistory.length > 0 && (
            <button 
              onClick={returnToActiveChat}
              className="active-chat-button"
              title="Return to active chat"
            >
              {/* <MessageCircle size={20} /> */}
              {/* <span>Chats</span> */}
            </button>
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

  // Creator View
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

  // Chat View
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
              <button onClick={() => socket?.connect()} className="reconnect-btn">
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
                  key={idx}
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