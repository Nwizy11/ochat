// src/App.js - Fixed version with proper real-time messaging and swipe to reply
import React, { useState, useEffect, useRef } from 'react';
import { MessageCircle, Send, Copy, Check, Plus, User, List, X, Image as ImageIcon, Paperclip, Download } from 'lucide-react';
import QRCodeStyling from 'qr-code-styling';
import io from 'socket.io-client';
import axios from 'axios';
import './app.css';

const API_URL = 'https://anonym-backend.onrender.com';
let socket;

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];

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
  const [replyingTo, setReplyingTo] = useState(null);
  const [selectedImage, setSelectedImage] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [viewingImage, setViewingImage] = useState(null);
  const messagesEndRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const audioContextRef = useRef(null);
  const fileInputRef = useRef(null);
  const [generatingQR, setGeneratingQR] = useState(false);

  // Initialize audio context for notification sound
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

  const isPageVisible = () => {
    return document.visibilityState === 'visible';
  };

  // Initialize socket connection
  useEffect(() => {
    console.log('🔌 Initializing socket connection to:', API_URL);
    
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
      const urlParams = new URLSearchParams(window.location.search);
      const linkParam = urlParams.get('link');
      const creatorParam = urlParams.get('creator');
      
      loadMyLinks();
      await loadMyChatHistory();
      
      if (creatorParam) {
        console.log('🔄 Restoring creator session:', creatorParam);
        await restoreCreatorSession(creatorParam);
      } else if (linkParam) {
        console.log('📎 Direct link detected:', linkParam);
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
        links.unshift({
          linkId,
          creatorId,
          createdAt: Date.now()
        });
        
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
      console.log('📥 Socket: Loading messages:', messages?.length || 0);
      
      if (activeConvId && currentConv) {
        setCurrentConv(prev => ({
          ...prev,
          messages: messages || []
        }));
      }
    };

    const handleNewMessage = ({ convId, message: newMessage }) => {
      console.log('📩 New message received:', { convId, message: newMessage, activeConvId });
      
      const isMessageFromOther = newMessage.isCreator !== isCreator;
      
      if (convId === activeConvId && currentConv) {
        setCurrentConv(prev => ({
          ...prev,
          messages: [...(prev.messages || []), newMessage],
          lastMessage: newMessage.timestamp
        }));
        
        if (isMessageFromOther && !isPageVisible()) {
          playNotificationSound();
          
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
      
      if (isCreator) {
        setConversations(prev => 
          prev.map(conv => {
            if (conv.id === convId) {
              const isViewingThisChat = (view === 'chat' && activeConvId === convId);
              const shouldIncrementUnread = !newMessage.isCreator && !isViewingThisChat;
              const newUnreadCount = shouldIncrementUnread 
                ? (conv.unreadCount || 0) + 1 
                : (conv.unreadCount || 0);
              
              if (shouldIncrementUnread && !isPageVisible()) {
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
  }, [socket, myLinkId, view, activeConvId]);

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
    if (totalMessages <= readStatus.readUpToMessageCount) {
      return 0;
    }
    
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

  const sendMessageHandler = async () => {
    if ((!message.trim() && !selectedImage) || !activeConvId || !socket || !socket.connected) {
      return;
    }
    
    if (uploadingImage) return; // Prevent double sending
    
    const messageText = message.trim();
    const imageToSend = selectedImage;
    const replyToSend = replyingTo;
    
    // Clear inputs immediately
    setMessage('');
    setReplyingTo(null);
    setSelectedImage(null);
    setImagePreview(null);
    
    // Create message ID for tracking
    const messageId = Date.now() + Math.random();
    
    // Create temporary message for immediate display
    const tempMessage = {
      id: messageId,
      text: messageText,
      isCreator,
      timestamp: Date.now(),
      replyTo: replyToSend,
      image: imageToSend ? imageToSend : null,
      uploading: imageToSend ? true : false
    };
    
    // Add message to UI immediately
    setCurrentConv(prev => ({
      ...prev,
      messages: [...(prev.messages || []), tempMessage],
      lastMessage: Date.now()
    }));
    
    // Set uploading state if there's an image
    if (imageToSend) {
      setUploadingImage(true);
    }
    
    // Send to server
    socket.emit('send-message', {
      convId: activeConvId,
      message: messageText,
      isCreator,
      replyTo: replyToSend,
      image: imageToSend
    }, (response) => {
      // Callback after server confirms receipt
      setUploadingImage(false);
      
      if (response && response.success) {
        // Update the message to remove uploading state
        setCurrentConv(prev => ({
          ...prev,
          messages: prev.messages.map(msg => 
            msg.id === messageId ? { ...msg, uploading: false } : msg
          )
        }));
      }
    });
    
    socket.emit('stop-typing', { convId: activeConvId });
    
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
        })
        .catch(() => {
          copyToClipboardFallback(fullLink);
        });
    } else {
      copyToClipboardFallback(fullLink);
    }
  };

  //qrcode
  const downloadQRCode = async () => {
  if (!myLinkId || generatingQR) return;
  
  setGeneratingQR(true);
  
  try {
    const fullLink = `${window.location.origin}/?link=${myLinkId}`;
    
    // Create canvas for QR code with branding
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 920;
    const ctx = canvas.getContext('2d');
    
    // White background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Create QR Code with custom styling
    const qrCode = new QRCodeStyling({
      width: 700,
      height: 700,
      data: fullLink,
      margin: 20,
      qrOptions: {
        typeNumber: 0,
        mode: 'Byte',
        errorCorrectionLevel: 'H'
      },
      imageOptions: {
        hideBackgroundDots: true,
        imageSize: 0.3,
        margin: 8
      },
      dotsOptions: {
        type: 'rounded',
        color: '#4169E1',
        gradient: {
          type: 'linear',
          rotation: 0,
          colorStops: [
            { offset: 0, color: '#667eea' },
            { offset: 1, color: '#764ba2' }
          ]
        }
      },
      backgroundOptions: {
        color: '#ffffff'
      },
      cornersSquareOptions: {
        type: 'extra-rounded',
        color: '#667eea'
      },
      cornersDotOptions: {
        type: 'dot',
        color: '#764ba2'
      }
    });
    
    // Get QR code as blob
    const qrBlob = await qrCode.getRawData('png');
    const qrImage = await createImageBitmap(qrBlob);
    
    // Draw QR code centered
    ctx.drawImage(qrImage, 50, 80, 700, 700);
    
    // Add rounded rectangle background for branding
    const brandingY = 800;
    const brandingHeight = 100;
    ctx.fillStyle = '#f8f9ff';
    roundRect(ctx, 50, brandingY, 700, brandingHeight, 15);
    ctx.fill();
    
    // Add "Ochat.fun" text
    ctx.fillStyle = '#667eea';
    ctx.font = 'bold 48px Inter, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Ochat.fun', 400, brandingY + 35);
    
    // Add copyright text
    ctx.fillStyle = '#999';
    ctx.font = '24px Inter, -apple-system, sans-serif';
    ctx.fillText('Scan to chat privately', 400, brandingY + 72);
    
    // Convert to blob and download
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ochat-qr-${myLinkId}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      setGeneratingQR(false);
    }, 'image/png');
    
  } catch (error) {
    console.error('Error generating QR code:', error);
    alert('Failed to generate QR code');
    setGeneratingQR(false);
  }
};

// Helper function to draw rounded rectangle
const roundRect = (ctx, x, y, width, height, radius) => {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
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
      setReplyingTo(null);
      window.history.pushState({}, '', `/?creator=${myLinkId}`);
    } else {
      setView('home');
      setMyLinkId(null);
      setMyCreatorId(null);
      setActiveConvId(null);
      setConversations([]);
      setCurrentConv(null);
      setIsCreator(false);
      setReplyingTo(null);
      window.history.pushState({}, '', '/');
    }
  };

  const viewConversationList = () => {
    if (myLinkId) {
      setView('creator');
      setActiveConvId(null);
      setCurrentConv(null);
      setReplyingTo(null);
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

  const handleSwipeReply = (msg) => {
    setReplyingTo({
      id: msg.id,
      text: msg.text,
      isCreator: msg.isCreator,
      hasImage: !!msg.image
    });
  };

  const handleImageSelect = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Validate file type
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      alert('Please select a valid image file (JPEG, PNG, GIF, or WebP)');
      return;
    }

    // Validate file size
    if (file.size > MAX_IMAGE_SIZE) {
      alert('Image size must be less than 5MB');
      return;
    }

    // Read and convert to base64
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = reader.result;
      setSelectedImage(base64String);
      setImagePreview(base64String);
    };
    reader.readAsDataURL(file);
  };

  const removeSelectedImage = () => {
    setSelectedImage(null);
    setImagePreview(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const openImageViewer = (imageData) => {
    setViewingImage(imageData);
  };

  const closeImageViewer = () => {
    setViewingImage(null);
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
            >
            </button>
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
  <div className="link-buttons">
    <button onClick={copyLink} className="copy-button">
      {copied ? <Check size={16} /> : <Copy size={16} />}
      <span>{copied ? 'Copied!' : 'Copy'}</span>
    </button>
    <button 
      onClick={downloadQRCode} 
      className="qr-button"
      disabled={generatingQR}
      title="Download QR Code"
    >
      {generatingQR ? (
        <div className="spinner-small"></div>
      ) : (
        <Download size={16} />
      )}
      <span>{generatingQR ? 'Generating...' : 'QR'}</span>
    </button>
  </div>
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
                <SwipeableMessage
                  key={idx}
                  msg={msg}
                  isOwn={msg.isCreator === isCreator}
                  onSwipeReply={() => handleSwipeReply(msg)}
                  onImageClick={openImageViewer}
                  formatTime={formatTime}
                  isCreator={isCreator}
                />
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

          {replyingTo && (
            <div className="reply-preview-container">
              <div className="reply-preview-bar"></div>
              <div className="reply-preview-info">
                <div className="reply-preview-sender">
                  Replying to {replyingTo.isCreator === isCreator ? 'yourself' : (replyingTo.isCreator ? 'Chat Creator' : 'Anonymous User')}
                </div>
                <div className="reply-preview-message">
                  {replyingTo.hasImage && '📷 '}
                  {replyingTo.text || 'Image'}
                </div>
              </div>
              <button 
                className="reply-preview-close"
                onClick={() => setReplyingTo(null)}
              >
                <X size={18} />
              </button>
            </div>
          )}

          {imagePreview && (
            <div className="image-preview-container">
              <div className="image-preview-wrapper">
                <img src={imagePreview} alt="Preview" className="image-preview" />
                <button 
                  className="image-preview-remove"
                  onClick={removeSelectedImage}
                >
                  <X size={20} />
                </button>
              </div>
            </div>
          )}

          <div className="input-container">
            <input
              type="file"
              ref={fileInputRef}
              accept="image/*"
              onChange={handleImageSelect}
              style={{ display: 'none' }}
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              className="attach-button"
              disabled={!socketConnected || uploadingImage}
              title="Attach image"
            >
              <Paperclip size={20} />
            </button>
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
              disabled={(!message.trim() && !selectedImage) || !socketConnected || uploadingImage}
            >
              {uploadingImage ? <div className="spinner-small"></div> : <Send size={20} />}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      {viewingImage && <ImageViewer imageData={viewingImage} onClose={closeImageViewer} />}
      {null}
    </>
  );
}

// Image Viewer Modal Component
function ImageViewer({ imageData, onClose }) {
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  if (!imageData) return null;

  return (
    <div className="image-viewer-overlay" onClick={onClose}>
      <div className="image-viewer-container">
        <button className="image-viewer-close" onClick={onClose}>
          <X size={24} />
        </button>
        <img 
          src={imageData} 
          alt="Full size" 
          className="image-viewer-image"
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    </div>
  );
}

// SwipeableMessage Component
function SwipeableMessage({ msg, isOwn, onSwipeReply, onImageClick, formatTime, isCreator }) {
  const [offset, setOffset] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const startX = useRef(0);
  const currentX = useRef(0);
  const SWIPE_THRESHOLD = 80;

  const handleStart = (clientX) => {
    setIsDragging(true);
    startX.current = clientX;
    currentX.current = clientX;
  };

  const handleMove = (clientX) => {
    if (!isDragging) return;
    
    currentX.current = clientX;
    const diff = clientX - startX.current;
    
    // Allow swipe left for own messages, right for others
    if ((isOwn && diff < 0) || (!isOwn && diff > 0)) {
      setOffset(Math.min(Math.abs(diff), SWIPE_THRESHOLD));
    }
  };

  const handleEnd = () => {
    setIsDragging(false);
    
    if (offset >= SWIPE_THRESHOLD) {
      onSwipeReply();
    }
    
    setOffset(0);
  };

  const handleTouchStart = (e) => {
    handleStart(e.touches[0].clientX);
  };

  const handleTouchMove = (e) => {
    handleMove(e.touches[0].clientX);
  };

  const handleMouseDown = (e) => {
    handleStart(e.clientX);
  };

  const handleMouseMove = (e) => {
    handleMove(e.clientX);
  };

  const handleMouseUp = () => {
    handleEnd();
  };

  const handleMouseLeave = () => {
    if (isDragging) {
      handleEnd();
    }
  };

  const transform = isOwn ? `translateX(-${offset}px)` : `translateX(${offset}px)`;
  const opacity = Math.min(offset / SWIPE_THRESHOLD, 1);

  return (
    <div
      className="message-wrapper"
      style={{
        justifyContent: isOwn ? 'flex-end' : 'flex-start'
      }}
    >
      <div className="swipeable-message-container">
        {/* Reply icon - shows on swipe */}
        {!isOwn && offset > 20 && (
          <div 
            className="swipe-reply-icon swipe-reply-icon-left"
            style={{ opacity }}
          >
            ↩
          </div>
        )}
        
        <div
          className="swipeable-message-content"
          style={{
            transform,
            transition: isDragging ? 'none' : 'transform 0.3s ease'
          }}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleEnd}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
        >
          <div className={isOwn ? 'my-message' : 'their-message'}>
            {msg.replyTo && (
              <div className="message-reply-context">
                <div className="message-reply-line"></div>
                <div className="message-reply-details">
                  <div className="message-reply-sender">
                    {msg.replyTo.isCreator === isCreator ? 'You' : (msg.replyTo.isCreator ? 'Chat Creator' : 'Anonymous')}
                  </div>
                  <div className="message-reply-text">
                    {msg.replyTo.hasImage && '📷 '}
                    {msg.replyTo.text || 'Image'}
                  </div>
                </div>
              </div>
            )}
            
            {msg.image && (
              <div className="message-image-container">
                {msg.uploading ? (
                  <div className="message-image-uploading">
                    <div className="spinner"></div>
                    <span>Uploading...</span>
                  </div>
                ) : (
                  <img 
                    src={msg.image} 
                    alt="Shared" 
                    className="message-image"
                    onClick={() => onImageClick(msg.image)}
                  />
                )}
              </div>
            )}
            
            {msg.text && <p className="message-text">{msg.text}</p>}
            <div className="message-time">{formatTime(msg.timestamp)}</div>
          </div>
        </div>

        {/* Reply icon - shows on swipe */}
        {isOwn && offset > 20 && (
          <div 
            className="swipe-reply-icon swipe-reply-icon-right"
            style={{ opacity }}
          >
            ↩
          </div>
        )}
      </div>
    </div>
  );
}

export default App;