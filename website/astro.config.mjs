// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://simfile.dev',
  integrations: [
    sitemap(),
    starlight({
      title: 'Simfile',
      description: 'Deterministic simulation worlds for agentic organizations.',
      components: {
        ThemeSelect: './src/components/EmptyThemeSelect.astro',
        SiteTitle: './src/components/SiteTitle.astro',
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/noopolis/simfile' },
      ],
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', slug: 'introduction' },
            { label: 'Quickstart', slug: 'quickstart' },
            { label: 'Concepts', slug: 'concepts' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Live Viewer', slug: 'guides/live-viewer' },
            { label: 'Skins', slug: 'guides/skins' },
            { label: 'Spawnfile Integration', slug: 'guides/spawnfile-integration' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Simfile Schema', slug: 'reference/simfile' },
            { label: 'CLI', slug: 'reference/cli' },
          ],
        },
      ],
    }),
  ],
});
