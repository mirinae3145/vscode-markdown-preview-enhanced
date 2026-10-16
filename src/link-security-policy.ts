import * as vscode from 'vscode';
import { inspectMPEConfig } from './config';

const RESERVED_SCHEMES = new Set([
  'javascript',
  'vbscript',
  'data',
  'command',
  'blob',
  'filesystem',
  'file',
]);

/** Only explicit user settings may extend preview link permissions. */
export function getAdditionalLinkSchemes(): string[] {
  const value = inspectMPEConfig<unknown>('additionalLinkSchemes')?.globalValue;
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value
        .filter(
          (scheme): scheme is string =>
            typeof scheme === 'string' &&
            scheme === scheme.trim() &&
            /^[a-z][a-z0-9+.-]*$/i.test(scheme) &&
            !RESERVED_SCHEMES.has(scheme.toLowerCase()),
        )
        .map((scheme) => scheme.toLowerCase()),
    ),
  ];
}

/** Recheck the final decoded URI before handing it to an opener. */
export function previewLinkAction(
  href: string,
  sourceScheme: string,
): 'blocked' | 'custom' | 'default' {
  // Control characters can disguise a scheme after URI parsing.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(href)) {
    return 'blocked';
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(href.trim())?.[1]?.toLowerCase();
  if (!scheme) {
    return 'default';
  }
  if (RESERVED_SCHEMES.has(scheme) && scheme !== 'file') {
    return 'blocked';
  }
  if (getAdditionalLinkSchemes().includes(scheme)) {
    return 'custom';
  }
  if (
    // A source scheme is a file route only if VS Code has a filesystem
    // provider for it; a forged custom source URI cannot grant permission.
    (scheme === sourceScheme.toLowerCase() &&
      vscode.workspace.fs.isWritableFileSystem(scheme) !== undefined) ||
    [
      'file',
      'http',
      'https',
      'ftp',
      'ftps',
      'mailto',
      'tel',
      'callto',
      'sms',
      'cid',
      'xmpp',
    ].includes(scheme)
  ) {
    return 'default';
  }
  return 'blocked';
}
