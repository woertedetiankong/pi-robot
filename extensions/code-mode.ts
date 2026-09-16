import { createCodeModeExtension } from "../packages/pi-code-mode/src/pi/extension.ts";
import { codeModeDocumentTool } from "../packages/pi-embedded-docs/integrations/code-mode.ts";
export default function (pi) {
  return createCodeModeExtension({ tools: [codeModeDocumentTool(pi)] })(pi);
}
