export const googleTagId = 'G-LZQ6G6JGJE';

export function googleAnalyticsScriptSrc() {
  return `https://www.googletagmanager.com/gtag/js?id=${googleTagId}`;
}

export function googleAnalyticsInlineScript() {
  return [
    'window.dataLayer = window.dataLayer || [];',
    'function gtag(){dataLayer.push(arguments);}',
    "gtag('js', new Date());",
    `gtag('config', ${JSON.stringify(googleTagId)});`,
  ].join('\n');
}
