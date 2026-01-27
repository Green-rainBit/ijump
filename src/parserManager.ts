import * as vscode from 'vscode';
import { IParserService, DecorationInfo, CommentImplementation, JumpTarget } from './parserInterface';
import { GoAstParser } from './goAstParser';
import { GoplsService } from './goplsService';

/**
 * 解析器模式
 */
export type ParserMode = 'auto' | 'parser' | 'gopls';

/**
 * ParserManager - 管理解析器模式切换
 * 
 * 支持在自定义 Go 解析器和 gopls 之间切换
 * auto 模式下优先使用 parser，parser 不可用时回退到 gopls
 */
export class ParserManager implements IParserService {
    private goAstParser: GoAstParser;
    private goplsService: GoplsService;
    private currentService: IParserService | null = null;
    private currentMode: ParserMode = 'auto';
    private statusBarItem: vscode.StatusBarItem;
    private isInitialized: boolean = false;

    constructor(private context: vscode.ExtensionContext) {
        this.goAstParser = new GoAstParser(context.extensionPath);
        this.goplsService = new GoplsService();

        // 创建状态栏项
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            100
        );
        this.statusBarItem.command = 'ijump.switchMode';
        this.statusBarItem.tooltip = '点击切换 IJump 解析模式';
        context.subscriptions.push(this.statusBarItem);

        // 监听配置变化
        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('ijump.parserMode')) {
                    this.onConfigurationChanged();
                }
            })
        );
    }

    /**
     * 初始化解析器管理器
     */
    async initialize(): Promise<void> {
        if (this.isInitialized) {
            return;
        }

        await this.selectParser();
        this.updateStatusBar();
        this.statusBarItem.show();
        this.isInitialized = true;
    }

    /**
     * 获取配置的解析模式
     */
    private getConfiguredMode(): ParserMode {
        const config = vscode.workspace.getConfiguration('ijump');
        return config.get<ParserMode>('parserMode', 'auto');
    }

    /**
     * 配置变化时重新选择解析器
     */
    private async onConfigurationChanged(): Promise<void> {
        const newMode = this.getConfiguredMode();
        if (newMode !== this.currentMode) {
            console.log(`[IJump] 配置变化，切换模式: ${this.currentMode} -> ${newMode}`);
            await this.selectParser();
            this.updateStatusBar();

            // 通知用户
            vscode.window.showInformationMessage(
                `IJump: 已切换到 ${this.getServiceName()} 模式`
            );
        }
    }

    /**
     * 根据配置和可用性选择解析器
     * auto 模式优先使用 parser
     */
    async selectParser(): Promise<IParserService> {
        const configMode = this.getConfiguredMode();
        this.currentMode = configMode;

        console.log(`[IJump] 当前配置模式: ${configMode}`);

        // gopls 模式
        if (configMode === 'gopls') {
            if (await this.goplsService.isAvailable()) {
                console.log('[IJump] 使用 gopls 模式');
                this.currentService = this.goplsService;
                return this.goplsService;
            }

            vscode.window.showWarningMessage(
                'IJump: gopls 不可用（请确保已安装 Go 扩展），回退到 parser 模式'
            );
        }

        // parser 模式
        if (configMode === 'parser') {
            if (await this.goAstParser.isAvailable()) {
                console.log('[IJump] 使用 parser 模式');
                this.currentService = this.goAstParser;
                return this.goAstParser;
            }

            vscode.window.showWarningMessage(
                'IJump: parser 不可用，尝试使用 gopls 模式'
            );

            // 尝试 gopls 作为备用
            if (await this.goplsService.isAvailable()) {
                console.log('[IJump] parser 不可用，回退到 gopls');
                this.currentService = this.goplsService;
                return this.goplsService;
            }
        }

        // auto 模式 - 优先 parser
        if (configMode === 'auto') {
            // 首先尝试 parser
            if (await this.goAstParser.isAvailable()) {
                console.log('[IJump] auto 模式: 使用 parser');
                this.currentService = this.goAstParser;
                return this.goAstParser;
            }

            // parser 不可用，尝试 gopls
            if (await this.goplsService.isAvailable()) {
                console.log('[IJump] auto 模式: parser 不可用，使用 gopls');
                this.currentService = this.goplsService;
                return this.goplsService;
            }
        }

        // 都不可用，使用 parser 作为默认（可能会在运行时编译）
        console.log('[IJump] 使用默认 parser 模式');
        this.currentService = this.goAstParser;
        return this.goAstParser;
    }

    /**
     * 更新状态栏显示
     */
    private updateStatusBar(): void {
        const serviceName = this.currentService?.getServiceName() || 'unknown';
        const icon = serviceName === 'gopls' ? '$(symbol-interface)' : '$(symbol-class)';
        this.statusBarItem.text = `${icon} IJump: ${serviceName}`;
    }

    /**
     * 获取当前服务
     */
    private async getCurrentService(): Promise<IParserService> {
        if (!this.currentService) {
            await this.selectParser();
        }
        return this.currentService!;
    }

    // ==================== IParserService 接口实现 ====================

    async isAvailable(): Promise<boolean> {
        const service = await this.getCurrentService();
        return service.isAvailable();
    }

    getServiceName(): string {
        return this.currentService?.getServiceName() || 'unknown';
    }

    async getInterfaceDecorations(document: vscode.TextDocument): Promise<DecorationInfo[]> {
        const service = await this.getCurrentService();
        return service.getInterfaceDecorations(document);
    }

    async getImplementationDecorations(document: vscode.TextDocument): Promise<DecorationInfo[]> {
        const service = await this.getCurrentService();
        return service.getImplementationDecorations(document);
    }

    async getAllDecorations(document: vscode.TextDocument): Promise<{
        interfaceDecorations: DecorationInfo[];
        implementationDecorations: DecorationInfo[];
        lineToMethodMap: Map<number, string>;
        lineTypeMap: Map<number, 'interface' | 'implementation'>;
    }> {
        const service = await this.getCurrentService();
        return service.getAllDecorations(document);
    }

    clearCache(filePath?: string): void {
        this.goAstParser.clearCache(filePath);
        this.goplsService.clearCache(filePath);
        console.log('[IJump] 所有缓存已清除');
    }

    /**
     * 获取 GoAstParser 实例（用于兼容现有代码）
     */
    getGoAstParser(): GoAstParser {
        return this.goAstParser;
    }

    /**
     * 获取 GoplsService 实例
     */
    getGoplsService(): GoplsService {
        return this.goplsService;
    }

    /**
     * 获取当前模式
     */
    getCurrentMode(): ParserMode {
        return this.currentMode;
    }

    /**
     * 手动切换模式
     */
    async switchMode(mode: ParserMode): Promise<void> {
        const config = vscode.workspace.getConfiguration('ijump');
        await config.update('parserMode', mode, vscode.ConfigurationTarget.Global);
    }

    /**
     * 获取注释声明的接口实现关系
     * 返回 Map: 接口名 -> 实现该接口的结构体列表
     */
    async getCommentImplementations(document: vscode.TextDocument): Promise<Map<string, CommentImplementation[]>> {
        const service = await this.getCurrentService();
        return service.getCommentImplementations(document);
    }

    /**
     * 获取指定行号的实现跳转目标（支持注释声明）
     */
    async getImplementationTargets(document: vscode.TextDocument, line: number): Promise<JumpTarget[]> {
        const service = await this.getCurrentService();
        return service.getImplementationTargets(document, line);
    }
}
