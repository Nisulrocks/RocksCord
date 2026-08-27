import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { watchTheme } from './store/useSettingsStore';
import './styles/index.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

/*
 * Started outside React, and never torn down.
 *
 * The theme is a property of the document rather than of any component, and this has to
 * keep following the OS while the preference is `system` -- including while no part of
 * the tree that cares happens to be mounted. StrictMode's double-invoke would also make
 * an effect-based version subscribe twice on every mount.
 */
watchTheme();

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
