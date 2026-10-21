import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const PAGE_BY_PATH = {
  '/login.html': 'login.html',
  '/dashboard.html': 'dashboard.html',
  '/challan-form.html': 'challan-form.html',
  '/challan-detail.html': 'challan-detail.html',
  '/admin.html': 'admin.html',
  '/change-password.html': 'change-password.html'
};

function pageForPath() {
  const path = window.location.pathname.toLowerCase();
  if (path === '/' || path === '/index.html') {
    return localStorage.getItem('challan_token') ? 'dashboard.html' : 'login.html';
  }
  return PAGE_BY_PATH[path] || (localStorage.getItem('challan_token') ? 'dashboard.html' : 'login.html');
}

function navigateTo(href) {
  const target = new URL(href, window.location.href);
  if (PAGE_BY_PATH[target.pathname.toLowerCase()]) {
    window.location.assign(`${target.pathname}${target.search}${target.hash}`);
  } else {
    window.location.assign(target.href);
  }
}

function rewriteLegacyMarkup(markup) {
  return markup
    .replace(/(href|src)="assets\//g, '$1="/legacy/assets/')
    .replace(/(href|src)="css\//g, '$1="/legacy/css/')
    .replace(/(href|src)="js\//g, '$1="/legacy/js/');
}

function LegacyPage({ template }) {
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const root = document.getElementById('legacy-root');
    const injectedScripts = [];

    async function loadPage() {
      try {
        document.querySelectorAll('body > script[data-legacy-script="true"]').forEach((script) => script.remove());
        document.querySelectorAll('body > .topbar').forEach((bar) => bar.remove());
        const response = await fetch(`/legacy/${template}`);
        if (!response.ok) throw new Error(`Unable to load frontend page (${response.status}).`);
        const html = rewriteLegacyMarkup(await response.text());
        const parsed = new DOMParser().parseFromString(html, 'text/html');
        if (cancelled) return;

        root.replaceChildren();
        Array.from(parsed.body.childNodes).forEach((node) => root.appendChild(document.importNode(node, true)));

        const scripts = Array.from(root.querySelectorAll('script'));
        for (const script of scripts) {
          if (cancelled) return;
          const replacement = document.createElement('script');
          replacement.dataset.legacyScript = 'true';
          injectedScripts.push(replacement);
          Array.from(script.attributes).forEach((attribute) => replacement.setAttribute(attribute.name, attribute.value));
          if (script.src) {
            replacement.src = new URL(script.getAttribute('src'), window.location.href).href;
            await new Promise((resolve, reject) => {
              replacement.onload = resolve;
              replacement.onerror = () => reject(new Error(`Unable to load ${replacement.src}.`));
              document.body.appendChild(replacement);
            });
            if (cancelled) {
              replacement.remove();
              return;
            }
          } else {
            replacement.textContent = script.textContent;
            document.body.appendChild(replacement);
          }
          script.remove();
        }
      } catch (loadError) {
        console.error('[React] Legacy page load failed', loadError);
        if (!cancelled) setError(loadError);
      }
    }

    loadPage();
    return () => {
      cancelled = true;
      root.replaceChildren();
      injectedScripts.forEach((script) => script.remove());
      document.querySelectorAll('body > script[data-legacy-script="true"]').forEach((script) => script.remove());
      document.querySelectorAll('body > .topbar').forEach((bar) => bar.remove());
    };
  }, [template]);

  useEffect(() => {
    const handleClick = (event) => {
      const anchor = event.target.closest('a');
      if (!anchor || !anchor.getAttribute('href')) return;
      const href = anchor.getAttribute('href');
      if (/^(dashboard|login|admin|challan-form|challan-detail|change-password|index)\.html/.test(href)) {
        event.preventDefault();
        navigateTo(href);
      }
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, []);

  if (error) return <div className="react-load-error">The page could not be loaded. Please refresh and try again.</div>;
  return <div id="legacy-root" />;
}

function App() {
  const [template, setTemplate] = useState(pageForPath);

  useEffect(() => {
    const update = () => setTemplate(pageForPath());
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);

  return <LegacyPage key={template} template={template} />;
}

createRoot(document.getElementById('root')).render(
  <App />
);
