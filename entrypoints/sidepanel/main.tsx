import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@/assets/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('BossPilot 启动失败：找不到 #root 容器。');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
