// src/App.js - Enhanced Frontend with Session Persistence
import React, { useState, useEffect, useRef } from 'react';
import { MessageCircle, Send, Copy, Check, Plus, User, List } from 'lucide-react';
import io from 'socket.io-client';
import axios from 'axios';
import './app.css';

const API_URL = 'http://localhost:5000';
let socket;

function App() {
  const [view, setView] = useState('home');
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
  const messagesEndRef = useRef(null);
  const typingTimeoutRef = useRef(null);

  // Initialize socket connection
  useEffect(() => {
    socket = io(API_URL, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 10
    });
    
    socket.on('connect', () => {
      console.log('✅ Connected to server');
      setSocketConnected(true);
    });
    
    socket.on('disconnect', () => {
      console.log('⚠️ Disconnected from server');
      setSocketConnected(false);
    });
    
    socket.on('connect_error', (error) => {
      console.error('❌ Connection error:', error);
      setSocketConnected(false);
    });
    
    socket.on('reconnect', (attemptNumber) => {
      console.log('🔄 Reconnected after', attemptNumber, 'attempts');
      setSocketConnected(true);
    });
    
    return () => {
      if (socket) socket.disconnect();
    };
  }, []);

  // Check for saved creator session or direct link on mount
  useEffect(() => {
    // Load saved links from localStorage
    loadMyLinks();
    
    const urlParams = new URLSearchParams(window.location.search);
    const linkParam = urlParams.get('link');
    const creatorParam = urlParams.get('creator');
    
    // Check if this is a creator returning to their conversation list
    if (creatorParam) {
      console.log('🔄 Restoring creator session:', creatorParam);
      restoreCreatorSession(creatorParam);
    }
    // Check if this is someone joining via direct link
    else if (linkParam) {
      console.log('📎 Direct link detected:', linkParam);
      handleDirectLink(linkParam);
    }
  }, []);

  // Load my links from localStorage
  const loadMyLinks = () => {
    try {
      const saved = localStorage.getItem('my_chat_links');
      if (saved) {
        const links = JSON.parse(saved);
        setMyLinks(links);
        console.log('📚 Loaded saved links:', links.length);
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
      
      // Check if link already exists
      if (!links.some(l => l.linkId === linkId)) {
        links.unshift({
          linkId,
          creatorId,
          createdAt: Date.now()
        });
        
        // Keep only last 10 links
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
    setLoading(true);
    try {
      // Verify link exists
      const response = await axios.get(`${API_URL}/api/links/${linkId}`);
      const { link } = response.data;
      
      if (link) {
        setMyLinkId(linkId);
        setMyCreatorId(link.creatorId);
        setIsCreator(true);
        setView('creator');
        
        // Join link room for real-time updates
        socket.emit('join-link', { linkId, creatorId: link.creatorId });
        
        // Load existing conversations
        const convResponse = await axios.get(`${API_URL}/api/links/${linkId}/conversations`);
        setConversations(convResponse.data.conversations || []);
        
        console.log('✅ Creator session restored');
      }
    } catch (error) {
      console.error('Error restoring session:', error);
      window.history.replaceState({}, '', '/');
      setView('home');
    } finally {
      setLoading(false);
    }
  };

  // Handle direct link access
  const handleDirectLink = async (linkId) => {
    setLoading(true);
    try {
      // Verify link exists
      const verifyResponse = await axios.get(`${API_URL}/api/links/${linkId}/verify`);
      
      if (verifyResponse.data.exists) {
        // Create new conversation (without adding to list yet)
        const response = await axios.post(`${API_URL}/api/conversations/create`, {
          linkId: linkId
        });
        
        const { conversation } = response.data;
        
        setActiveConvId(conversation.id);
        setCurrentConv(conversation);
        setIsCreator(false);
        setView('chat');
        
        // Join conversation room
        socket.emit('join-conversation', { 
          convId: conversation.id, 
          isCreator: false 
        });
        
        console.log('✅ Joined chat via direct link');
      } else {
        alert('Invalid or expired link');
        window.history.replaceState({}, '', '/');
      }
    } catch (error) {
      console.error('Error joining via direct link:', error);
      alert('Invalid link or server error');
      window.history.replaceState({}, '', '/');
    } finally {
      setLoading(false);
    }
  };

  // Load messages for current conversation with real-time updates
  useEffect(() => {
    if (!socket) return;

    const handleLoadMessages = ({ messages }) => {
      if (currentConv) {
        setCurrentConv(prev => ({ 
          ...prev, 
          messages: messages || [] 
        }));
      }
    };

    const handleNewMessage = ({ convId, message: newMessage }) => {
      console.log('📩 New message received:', {
        convId,
        message: newMessage.text,
        isCreator: newMessage.isCreator,
        currentView: view,
        activeConvId
      });
      
      // Update current conversation if we're viewing it
      if (currentConv && convId === currentConv.id) {
        setCurrentConv(prev => ({
          ...prev,
          messages: [...(prev.messages || []), newMessage],
          lastMessage: newMessage.timestamp
        }));
      }
      
      // Update conversation list for creator
      if (isCreator) {
        setConversations(prev => 
          prev.map(conv => {
            if (conv.id === convId) {
              // Check if we're currently viewing this conversation
              const isViewingThisChat = (view === 'chat' && activeConvId === convId);
              
              // Only increment unread if:
              // 1. Message is from anonymous user (not creator)
              // 2. We're NOT currently viewing this conversation
              const shouldIncrementUnread = !newMessage.isCreator && !isViewingThisChat;
              
              const newUnreadCount = shouldIncrementUnread 
                ? (conv.unreadCount || 0) + 1 
                : (conv.unreadCount || 0);
              
              console.log('🔔 Unread badge update:', {
                convId,
                isViewingThisChat,
                shouldIncrementUnread,
                oldUnreadCount: conv.unreadCount || 0,
                newUnreadCount
              });
              
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
  }, [currentConv, isCreator]);

  // Load conversations for creator with real-time updates
  useEffect(() => {
    if (!socket || !myLinkId || view !== 'creator') return;

    const handleLoadConversations = ({ conversations: convs }) => {
      console.log('📋 Loaded conversations:', convs.length);
      // Calculate unread count for each conversation based on read status
      const conversationsWithUnread = convs.map(conv => {
        const unreadCount = calculateUnreadCount(conv);
        
        console.log(`Conversation ${conv.id}: ${unreadCount} unread messages`);
        
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
        // Check if conversation already exists
        const exists = prev.some(c => c.id === conversation.id);
        if (exists) return prev;
        
        // Calculate initial unread count based on read status
        const unreadCount = calculateUnreadCount(conversation);
        
        console.log('🔔 New conversation unread count:', unreadCount);
        
        return [...prev, { 
          ...conversation, 
          unreadCount 
        }];
      });
    };

    const handleConversationUpdated = ({ conversation }) => {
      console.log('🔄 Conversation updated:', conversation.id, 'Messages:', conversation.messages?.length);
      setConversations(prev => {
        const exists = prev.some(c => c.id === conversation.id);
        if (exists) {
          return prev.map(conv => {
            if (conv.id === conversation.id) {
              // If we're currently viewing this conversation in chat view, unread = 0
              const isViewingThisChat = (view === 'chat' && activeConvId === conversation.id);
              
              // If viewing, set to 0
              if (isViewingThisChat) {
                console.log('🔔 Viewing this chat, unread = 0');
                return {
                  ...conv,
                  ...conversation,
                  unreadCount: 0
                };
              }
              
              // If NOT viewing, preserve the existing unread count and only add new messages
              const oldMessageCount = conv.messages?.length || 0;
              const newMessageCount = conversation.messages?.length || 0;
              
              if (newMessageCount > oldMessageCount) {
                // There are new messages
                const newMessages = conversation.messages.slice(oldMessageCount);
                const newUnreadCount = newMessages.filter(msg => !msg.isCreator).length;
                const totalUnread = (conv.unreadCount || 0) + newUnreadCount;
                
                console.log('🔔 Badge update:', {
                  convId: conversation.id,
                  oldUnread: conv.unreadCount || 0,
                  newUnread: newUnreadCount,
                  totalUnread
                });
                
                return {
                  ...conv,
                  ...conversation,
                  unreadCount: totalUnread
                };
              }
              
              // No new messages, keep existing unread count
              return {
                ...conv,
                ...conversation,
                unreadCount: conv.unreadCount || 0
              };
            }
            return conv;
          });
        } else {
          // New conversation - calculate unread from messages
          const unreadCount = conversation.messages 
            ? conversation.messages.filter(msg => !msg.isCreator).length 
            : 0;
          
          console.log('🆕 New conversation via update:', conversation.id, 'unread:', unreadCount);
          
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
  }, [socket, myLinkId, view]);

  // Auto scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentConv?.messages]);

  const createNewLink = async () => {
    setLoading(true);
    try {
      const response = await axios.post(`${API_URL}/api/links/create`);
      const { linkId, creatorId } = response.data;
      
      setMyLinkId(linkId);
      setMyCreatorId(creatorId);
      setIsCreator(true);
      setView('creator');
      
      // Save link to localStorage
      saveMyLink(linkId, creatorId);
      
      // Update URL to persist session
      window.history.pushState({}, '', `/?creator=${linkId}`);
      
      // Join link room for real-time updates
      socket.emit('join-link', { linkId, creatorId });
      
      // Load existing conversations
      const convResponse = await axios.get(`${API_URL}/api/links/${linkId}/conversations`);
      const convs = convResponse.data.conversations || [];
      
      // Calculate unread counts based on read status
      const convsWithUnread = convs.map(conv => {
        const unreadCount = calculateUnreadCount(conv);
        return {
          ...conv,
          unreadCount
        };
      });
      
      setConversations(convsWithUnread);
      
      console.log('✅ Chat link created with conversations:', convsWithUnread);
    } catch (error) {
      console.error('Error creating link:', error);
      alert('Failed to create link. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Open existing link from My Chats
  const openExistingLink = async (linkId, creatorId) => {
    setLoading(true);
    try {
      // Verify link still exists
      const response = await axios.get(`${API_URL}/api/links/${linkId}`);
      const { link } = response.data;
      
      if (link) {
        setMyLinkId(linkId);
        setMyCreatorId(creatorId);
        setIsCreator(true);
        setView('creator');
        
        // Update URL to persist session
        window.history.pushState({}, '', `/?creator=${linkId}`);
        
        // Join link room for real-time updates
        socket.emit('join-link', { linkId, creatorId });
        
        // Load existing conversations
        const convResponse = await axios.get(`${API_URL}/api/links/${linkId}/conversations`);
        const convs = convResponse.data.conversations || [];
        
        // Calculate unread counts based on read status
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
    
    // Redirect to direct link URL
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
      
      // Mark ONLY this conversation as read and save to localStorage
      setConversations(prev => 
        prev.map(conv => {
          if (conv.id === convId) {
            console.log('✅ Marking conversation as read:', convId);
            
            // Save read status to localStorage
            saveReadStatus(convId, conversation.messages?.length || 0);
            
            return {
              ...conv,
              unreadCount: 0,
              lastReadTime: Date.now()
            };
          }
          // Keep other conversations unchanged
          return conv;
        })
      );
      
      // Join conversation room
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

  // Save read status to localStorage
  const saveReadStatus = (convId, readUpToMessageCount) => {
    try {
      const readStatus = JSON.parse(localStorage.getItem('chat_read_status') || '{}');
      readStatus[convId] = {
        readUpToMessageCount,
        timestamp: Date.now()
      };
      localStorage.setItem('chat_read_status', JSON.stringify(readStatus));
      console.log('💾 Saved read status:', convId, readUpToMessageCount);
    } catch (error) {
      console.error('Error saving read status:', error);
    }
  };

  // Get read status from localStorage
  const getReadStatus = (convId) => {
    try {
      const readStatus = JSON.parse(localStorage.getItem('chat_read_status') || '{}');
      return readStatus[convId] || null;
    } catch (error) {
      console.error('Error getting read status:', error);
      return null;
    }
  };

  // Calculate unread count based on read status
  const calculateUnreadCount = (conv) => {
    const readStatus = getReadStatus(conv.id);
    if (!readStatus) {
      // Never read - all anonymous messages are unread
      return conv.messages ? conv.messages.filter(m => !m.isCreator).length : 0;
    }
    
    // Count messages after the last read position
    const totalMessages = conv.messages?.length || 0;
    if (totalMessages <= readStatus.readUpToMessageCount) {
      // No new messages since last read
      return 0;
    }
    
    // Count only NEW anonymous messages
    const newMessages = conv.messages.slice(readStatus.readUpToMessageCount);
    return newMessages.filter(m => !m.isCreator).length;
  };

  const sendMessageHandler = () => {
    if (!message.trim() || !activeConvId || !socket) {
      console.warn('Cannot send message:', { 
        hasMessage: !!message.trim(), 
        hasConvId: !!activeConvId,
        hasSocket: !!socket 
      });
      return;
    }
    
    const messageText = message.trim();
    
    // Clear input immediately for better UX
    setMessage('');
    
    console.log('📤 Attempting to send message:', {
      convId: activeConvId,
      message: messageText,
      isCreator,
      socketConnected: socket.connected
    });
    
    // Send message via socket
    socket.emit('send-message', {
      convId: activeConvId,
      message: messageText,
      isCreator
    });
    
    // Stop typing indicator
    socket.emit('stop-typing', { convId: activeConvId });
  };

  const handleTyping = () => {
    if (!activeConvId || !socket) return;
    
    socket.emit('typing', { convId: activeConvId, isCreator });
    
    // Auto stop typing after 1 second
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
    
    // Try modern clipboard API first
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(fullLink)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
          console.log('📋 Link copied:', fullLink);
        })
        .catch(err => {
          // Fallback to older method
          copyToClipboardFallback(fullLink);
        });
    } else {
      // Use fallback for older browsers or insecure contexts
      copyToClipboardFallback(fullLink);
    }
  };

  const copyToClipboardFallback = (text) => {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    
    try {
      document.execCommand('copy');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      console.log('📋 Link copied (fallback):', text);
    } catch (err) {
      console.error('Failed to copy:', err);
      alert(`Copy this link: ${text}`);
    }
    
    document.body.removeChild(textArea);
  };

  const goBack = () => {
    if (view === 'chat' && isCreator) {
      // Return to creator conversation list
      setView('creator');
      setActiveConvId(null);
      setCurrentConv(null);
      window.history.pushState({}, '', `/?creator=${myLinkId}`);
      
      // DON'T reload conversations - keep existing state with unread counts
      // The socket events will keep them updated in real-time
    } else {
      // Return to home
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
  if (loading) {
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
            value={joinLinkId}
            onChange={(e) => setJoinLinkId(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && joinWithLink()}
            className="input"
          />
          <button onClick={joinWithLink} className="secondary-button" disabled={loading}>
            Join Chat
          </button>

          {/* Always show My Chat Links section */}
          <div className="divider" style={{ marginTop: '30px' }}>
            <span className="divider-text">MY CHAT LINKS</span>
          </div>
          
          {myLinks.length > 0 ? (
            <div className="my-links-list">
              {myLinks.map(link => (
                <div key={link.linkId} className="my-link-item">
                  <div className="my-link-info">
                    <MessageCircle size={16} color="#667eea" />
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
                        if (window.confirm('Remove this link from your list?')) {
                          removeMyLink(link.linkId);
                        }
                      }}
                      className="my-link-delete-btn"
                    >
                      ×
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="my-links-empty">
              <p>No saved chat links yet</p>
              <p className="my-links-empty-hint">
                Create a chat link to get started
              </p>
            </div>
          )}

          <div className="features">
            <div className="feature">🔒 Completely Anonymous</div>
            <div className="feature">💬 Real-time Messaging</div>
            <div className="feature">🔗 Easy Link Sharing</div>
            <div className="feature">⏰ Auto-delete after 24 hours</div>
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
              <h2 className="header-title">Conversations</h2>
              <p className="header-subtitle">
                {conversations.length} active chat{conversations.length !== 1 ? 's' : ''}
                {conversations.some(c => c.unreadCount > 0) && 
                  ` • ${conversations.reduce((sum, c) => sum + (c.unreadCount || 0), 0)} unread`
                }
              </p>
            </div>
            <button onClick={goBack} className="back-button">
              Home
            </button>
          </div>

          <div className="link-section">
            <div className="link-info">
              <span className="link-label">Share this link:</span>
              <span className="link-id" title={`${window.location.origin}/?link=${myLinkId}`}>
                {window.location.origin}/?link={myLinkId}
              </span>
            </div>
            <button onClick={copyLink} className="copy-button">
              {copied ? <Check size={18} /> : <Copy size={18} />}
              <span>{copied ? 'Copied!' : 'Copy'}</span>
            </button>
          </div>

          <div className="conversation-list">
            {conversations.length === 0 ? (
              <div className="empty-state">
                <MessageCircle size={48} color="#ccc" />
                <p className="empty-text">No conversations yet</p>
                <p className="empty-subtext">Share your link to start chatting</p>
                <p className="empty-hint">Conversations appear after the first message is sent</p>
              </div>
            ) : (
              conversations.map(conv => {
                // Calculate unread count for display
                const displayUnreadCount = conv.unreadCount || 0;
                
                return (
                  <div
                    key={conv.id}
                    onClick={() => openConversation(conv.id)}
                    className="conversation-item"
                  >
                    <div className="avatar">
                      <User size={24} color="#667eea" />
                    </div>
                    <div className="conv-info">
                      <div className="conv-header">
                        <span className="conv-name">Anonymous User</span>
                        <span className="conv-time">
                          {formatTime(conv.lastMessage)}
                        </span>
                      </div>
                      <p className="last-message">
                        {conv.messages && conv.messages.length > 0
                          ? conv.messages[conv.messages.length - 1].text
                          : 'New conversation'}
                      </p>
                    </div>
                    {displayUnreadCount > 0 && (
                      <div className="unread-badge">
                        {displayUnreadCount}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    );
  }

  // Chat View
  if (view === 'chat' && currentConv) {
    return (
      <div className="container">
        <div className="app-container">
          <div className="chat-header">
            <button onClick={goBack} className="back-button-small">
              ←
            </button>
            <div className="chat-header-info">
              <div className="avatar-small">
                <User size={20} color="#667eea" />
              </div>
              <div>
                <h3 className="chat-title">
                  {isCreator ? 'Anonymous User' : 'Chat Owner'}
                </h3>
                <p className="chat-status" style={{ color: socketConnected ? '#22c55e' : '#ef4444' }}>
                  {socketConnected ? 'Online' : 'Connecting...'}
                </p>
              </div>
            </div>
            {/* Show conversation list button for creator */}
            {isCreator && (
              <button onClick={viewConversationList} className="list-button" title="View all conversations">
                <List size={20} />
              </button>
            )}
          </div>

          <div className="messages-container">
            {!currentConv.messages || currentConv.messages.length === 0 ? (
              <div className="empty-chat">
                <MessageCircle size={48} color="#ccc" />
                <p className="empty-chat-text">Start the conversation</p>
              </div>
            ) : (
              currentConv.messages.map(msg => (
                <div
                  key={msg.id}
                  className="message-wrapper"
                  style={{
                    justifyContent: msg.isCreator === isCreator ? 'flex-end' : 'flex-start'
                  }}
                >
                  <div className={msg.isCreator === isCreator ? 'my-message' : 'their-message'}>
                    <p className="message-text">{msg.text}</p>
                    <span className="message-time">
                      {new Date(msg.timestamp).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </span>
                  </div>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          {typingUser && (
            <div className="typing-indicator">
              {typingUser === 'creator' ? 'Chat Owner' : 'Anonymous User'} is typing...
            </div>
          )}

          <div className="input-container">
            <input
              type="text"
              placeholder="Type a message..."
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                handleTyping();
              }}
              onKeyPress={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendMessageHandler();
                }
              }}
              className="message-input"
              autoFocus
            />
            <button 
              onClick={sendMessageHandler} 
              className="send-button"
              disabled={!message.trim()}
              title="Send message"
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