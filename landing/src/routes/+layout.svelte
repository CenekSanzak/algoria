<script lang="ts">
  import '../app.css';
  import SiteHeader from '$lib/components/SiteHeader.svelte';
  import SiteFooter from '$lib/components/SiteFooter.svelte';

  let { children } = $props();
</script>

<a class="skip-link" href="#main">Skip to content</a>
<div id="top"></div>
<SiteHeader />
<main id="main">
  {@render children()}
</main>
<SiteFooter />
