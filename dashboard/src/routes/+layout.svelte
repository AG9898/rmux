<script lang="ts">
	import '../app.css';
	let { children } = $props();
</script>

<svelte:head>
	<title>Ralph Dashboard</title>
</svelte:head>

<div class="min-h-screen bg-bg">
	<header class="border-b border-border px-6 py-3 flex items-center justify-between">
		<div class="flex items-center gap-3">
			<span class="text-2xl">🤪</span>
			<h1 class="text-lg font-bold text-text">ralph dashboard</h1>
			<span class="text-xs text-text-dim font-normal">headless agent fleet</span>
		</div>
	</header>
	{@render children()}
</div>
