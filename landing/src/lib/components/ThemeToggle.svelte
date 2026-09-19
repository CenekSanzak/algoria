<script lang="ts">
  import { onMount } from 'svelte';

  // app.html applies the saved theme before paint; this only mirrors and flips it.
  let light = $state(false);

  onMount(() => {
    light = document.documentElement.dataset.theme === 'light';
  });

  function toggle() {
    light = !light;
    const root = document.documentElement;
    if (light) root.dataset.theme = 'light';
    else delete root.dataset.theme;
    try {
      localStorage.setItem('algoria-theme', light ? 'light' : 'dark');
    } catch {
      // Storage can be unavailable (private mode); the toggle still works for this visit.
    }
  }
</script>

<button type="button" aria-label={light ? 'Switch to dark theme' : 'Switch to light theme'} onclick={toggle}>
  {#if light}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
  {:else}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></svg>
  {/if}
</button>

<style>
  button {
    width: 30px;
    height: 30px;
    display: grid;
    place-items: center;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--raised);
    color: var(--txt-muted);
    cursor: pointer;
  }

  button:hover {
    color: var(--txt);
  }

  svg {
    width: 14px;
    height: 14px;
  }
</style>
