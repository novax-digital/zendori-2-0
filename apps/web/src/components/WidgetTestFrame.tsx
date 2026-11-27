'use client';

// The frame of a chat channel's "Test" tab (0050): the real widget on a
// stand-in page (/widget-test), in a browser mock like the designer's preview.
// "Neues Testgespräch" forgets what the widget keeps in this browser for the
// test and loads the frame again — the next message starts a new conversation.
import { useState } from 'react';
import Button from '@/components/ui/Button';
import { testStorageId, widgetStorageKeys } from '@/widget/storage';

export default function WidgetTestFrame({
  src,
  publicToken,
}: {
  /** /widget-test?org=…&channel=… */
  src: string;
  /** The channel's public widget token — names the test's storage keys. */
  publicToken: string;
}) {
  const [run, setRun] = useState(0);

  function startOver(): void {
    try {
      for (const key of widgetStorageKeys(testStorageId(publicToken))) {
        window.localStorage.removeItem(key);
      }
    } catch {
      // storage is blocked: the widget then keeps its session in memory only,
      // and reloading the frame starts over anyway
    }
    setRun((value) => value + 1);
  }

  return (
    <aside className="wt-preview" aria-label="Chat-Test">
      <div className="wd-preview-head">
        <span className="wd-preview-title">Dein Chat im Test</span>
        <Button type="button" size="sm" onClick={startOver}>
          Neues Testgespräch
        </Button>
      </div>
      <div className="wd-browser">
        <div className="wd-browser-bar" aria-hidden="true">
          <i />
          <i />
          <i />
          <span>deine-website.de</span>
        </div>
        {/* keyed: a new run mounts a fresh frame, and with it a fresh widget */}
        <iframe key={run} className="wt-frame" src={src} title="Chat-Fenster im Test" />
      </div>
    </aside>
  );
}
