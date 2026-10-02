import { Help, type Command } from "commander";

import { colors } from "./colors.ts";

export function configureColoredHelp(program: Command): void {
  let stream = process.stdout;

  program.configureHelp({
    prepareContext(this: Help, context) {
      Help.prototype.prepareContext.call(this, context);
      stream = context.error ? process.stderr : process.stdout;
    },
    styleTitle: (text) => colors.heading(text, stream),
    styleCommandText: (text) => colors.info(text, stream),
    styleSubcommandText: (text) => colors.info(text, stream),
    styleOptionText: (text) => colors.info(text, stream),
    styleArgumentText: (text) => colors.warning(text, stream),
    styleDescriptionText: (text) => colors.muted(text, stream),
  });
}
