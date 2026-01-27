import * as vscode from 'vscode';
import { ParserManager } from './parserManager';

/**
 * CodeLens 提供者
 * 提供点击跳转功能
 */
export class IJumpCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

    constructor(private parserManager: ParserManager) { }

    /**
     * 刷新 CodeLens
     */
    refresh(): void {
        this._onDidChangeCodeLenses.fire();
    }

    async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
        const config = vscode.workspace.getConfiguration('ijump');
        const displayMode = config.get<string>('displayMode', 'both');

        // 如果配置不显示 CodeLens，返回空
        if (displayMode !== 'codelens' && displayMode !== 'both') {
            return [];
        }

        // 仅处理 Go 文件
        if (document.languageId !== 'go') {
            return [];
        }

        try {
            const lenses: vscode.CodeLens[] = [];

            // 获取所有装饰信息
            const { interfaceDecorations, implementationDecorations } = await this.parserManager.getAllDecorations(document);

            // 接口定义 -> 跳转到实现
            for (const deco of interfaceDecorations) {
                // CodeLens 显示在该行上方
                const range = new vscode.Range(deco.line, 0, deco.line, 0);

                const command: vscode.Command = {
                    title: '$(symbol-interface) 跳转到实现',
                    command: 'ijump.jumpToImplementation',
                    arguments: [document.uri, deco.line],
                    tooltip: `跳转 to implementation of ${deco.name}`
                };

                lenses.push(new vscode.CodeLens(range, command));
            }

            // 实现 -> 跳转到接口
            for (const deco of implementationDecorations) {
                const range = new vscode.Range(deco.line, 0, deco.line, 0);

                const command: vscode.Command = {
                    title: '$(symbol-class) 跳转到接口',
                    command: 'ijump.jumpToInterface',
                    arguments: [document.uri, deco.line],
                    tooltip: `跳转 to interface definition, implementing ${deco.name}`
                };

                lenses.push(new vscode.CodeLens(range, command));
            }

            return lenses;
        } catch (error) {
            console.error('[IJump] 提供 CodeLens 失败:', error);
            return [];
        }
    }
}
