import React from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { App } from './App';
import { BrowserRoot } from './BrowserRoot';

createRoot(document.getElementById('root')!).render(<React.StrictMode>{!window.xterminal && location.protocol === 'https:' ? <BrowserRoot /> : <App />}</React.StrictMode>);
