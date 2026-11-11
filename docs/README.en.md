# Feishu Local Exporter

Save a Feishu document and its available assets to your browser's download folder. A Manifest V3 extension for desktop Chrome and Edge.

[中文说明](../README.md) · [Download v0.3.12](https://github.com/PAONAN9420/feishu-local-exporter/releases/tag/v0.3.12) · [Report an issue](https://github.com/PAONAN9420/feishu-local-exporter/issues/new/choose)

Exports supported Docx / Wiki document content to Markdown, plus images, downloadable videos, file attachments, code files, and ordinary document tables (CSV / HTML). Embedded Sheets and Bitable content currently retain source links only. Third-party app blocks and segmented video streams are not exported. International Lark domains are not supported.

## Install

Download the release asset `feishu-local-exporter-v0.3.12.zip`, extract it, open `chrome://extensions` or `edge://extensions`, enable Developer mode, and select **Load unpacked**. Choose the extracted folder containing `manifest.json`. Refresh your Feishu document and click **保存全文与素材** (save document and assets). The UI is currently in Chinese.

Use a recent desktop browser. This initial public test release was primarily validated on Windows; other operating systems remain unverified. Keep the document tab open while exporting. Updates are manual; this package is not distributed through a browser store.

## Privacy and limitations

The extension requests document data and assets from Feishu using the current page session, and saves results locally through the browser download manager. There is no developer backend or analytics SDK. Export only content you are authorized to save. The local export report can contain document URLs and identifiers; redact it before sharing an issue.

Markdown does not reproduce the original page pixel for pixel. Large images over 64 MiB, tenant-specific permissions, and changes to Feishu's page structure may cause failures. Missing content is reported. See the [Chinese README](../README.md) for the full support matrix.

## Development

Node.js 24+: run `npm ci`, then `npm test`. Load the resulting `dist/` directory. `npm run package` also requires PowerShell 7 and writes a ZIP and SHA-256 checksum to `artifacts/`. Tests use synthetic data and mocked network responses; they do not prove compatibility with every live document.

Issues and pull requests are welcome. If the tool is useful to you, consider giving it a star. Licensed under [MIT](../LICENSE). An independent project, not affiliated with Feishu.
