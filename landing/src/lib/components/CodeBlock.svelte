<script lang="ts">
  type Variant = 'block' | 'ask' | 'line';

  let { code, label, variant = 'block' }: { code: string; label: string; variant?: Variant } = $props();

  let copied = $state(false);
  let status = $state('');
  let codeEl: HTMLElement;
  let resetTimer: ReturnType<typeof setTimeout>;

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      copied = true;
      status = 'Copied to clipboard.';
    } catch {
      // Clipboard can be blocked (insecure context, permissions); select the text instead.
      const range = document.createRange();
      range.selectNodeContents(codeEl);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      status = 'Copy is unavailable. The text is selected; copy it manually.';
    }
    clearTimeout(resetTimer);
    resetTimer = setTimeout(() => (copied = false), 1800);
  }
</script>

<div class="code {variant}">
  <pre><code bind:this={codeEl}>{code}</code></pre>
  <button class="copy" class:done={copied} type="button" aria-label={copied ? 'Copied' : label} onclick={copy}>
    {#if copied}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
    {:else}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>
    {/if}
  </button>
  <span class="sr-only" role="status" aria-live="polite">{status}</span>
</div>

<style>
  .code {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 4px 6px 4px 0;
    border: 1px solid var(--border);
    border-radius: 11px;
    background: var(--well);
  }

  .code.line {
    align-items: center;
  }

  pre {
    flex: 1;
    min-width: 0;
    margin: 0;
    padding: 9px 0 9px 13px;
    font: 12.5px/1.8 var(--mono);
    color: var(--txt-sec);
    white-space: pre;
    overflow-x: auto;
    scrollbar-width: none;
  }

  pre::-webkit-scrollbar {
    display: none;
  }

  code {
    font: inherit;
  }

  .ask pre {
    font-family: var(--sans);
    font-size: 14px;
    color: var(--txt);
    white-space: pre-wrap;
  }

  .copy {
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    margin-top: 4px;
    display: grid;
    place-items: center;
    border: 1px solid transparent;
    border-radius: 8px;
    background: none;
    color: var(--txt-muted);
    cursor: pointer;
    transition: color 0.15s, background 0.15s, border-color 0.15s;
  }

  .line .copy {
    margin-top: 0;
  }

  .copy:hover {
    color: var(--txt);
    background: var(--active-bg);
    border-color: var(--border-strong);
  }

  .copy.done {
    color: var(--online);
  }

  .copy svg {
    width: 14px;
    height: 14px;
  }
</style>
