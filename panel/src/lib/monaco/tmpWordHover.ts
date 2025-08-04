//NOTE: exploratory code, not used in the final codebase
import * as monaco from 'monaco-editor';
import * as fivemConfigLang from "@/lib/monaco/fivemConfigLanguage";

export const register = (monacoInstance: typeof monaco) => {
    monacoInstance.languages.registerHoverProvider(fivemConfigLang.LANG, {
        provideHover: function (model, position) {
            const line = model.getLineContent(position.lineNumber);
            if (line.length === 0) return null;
            const word = model.getWordAtPosition(position);
            if (!word) return null;
            if (word.word !== 'chat') return null;

            return {
                range: new monaco.Range(
                    position.lineNumber,
                    word.startColumn,
                    position.lineNumber,
                    word.endColumn
                ),
                contents: [
                    { value: "**chat** _(9.9.9-dev)_ by Cfx.re" },
                    {
                        value:
                            "```md\n" +
                            'Provides baseline chat functionality using a NUI-based interface.' +
                            "\n```"
                    },
                    { value: "_system_resources/chat" }

                ],
            };
        },
    });
}
