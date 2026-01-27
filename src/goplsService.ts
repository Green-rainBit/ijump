import * as vscode from 'vscode';
import { IParserService, DecorationInfo, InterfaceInfo, StructInfo, MethodInfo } from './parserInterface';

/**
 * GoplsService - 使用 VS Code 内置 LSP API 与 gopls 交互
 * 
 * 这个服务类封装了 VS Code 的语言服务器协议 API，
 * 底层由 Go 扩展的 gopls 语言服务器提供支持。
 */
export class GoplsService implements IParserService {
    private isReady: boolean = false;
    private checkPromise: Promise<boolean> | null = null;

    // 缓存
    private decorationCache = new Map<string, {
        interfaceDecorations: DecorationInfo[];
        implementationDecorations: DecorationInfo[];
        lineToMethodMap: Map<number, string>;
        lineTypeMap: Map<number, 'interface' | 'implementation'>;
        timestamp: number;
    }>();
    private cacheTTL = 30000; // 30秒缓存

    getServiceName(): string {
        return 'gopls';
    }

    /**
     * 检查 gopls 是否可用
     * 通过检测 Go 扩展是否已激活来判断
     */
    async isAvailable(): Promise<boolean> {
        // 避免重复检查
        if (this.checkPromise) {
            return this.checkPromise;
        }

        this.checkPromise = this.doCheckGopls();
        return this.checkPromise;
    }

    private async doCheckGopls(): Promise<boolean> {
        try {
            // 检查 Go 扩展是否已安装并激活
            const goExtension = vscode.extensions.getExtension('golang.Go');

            if (!goExtension) {
                console.log('[IJump] Go 扩展未安装');
                return false;
            }

            if (!goExtension.isActive) {
                console.log('[IJump] 等待 Go 扩展激活...');
                try {
                    await goExtension.activate();
                } catch (activateError) {
                    console.error('[IJump] Go 扩展激活失败:', activateError);
                    return false;
                }
            }

            this.isReady = true;
            console.log('[IJump] gopls 服务已就绪');
            return true;
        } catch (error) {
            console.error('[IJump] 检查 gopls 可用性失败:', error);
            return false;
        }
    }

    /**
     * 获取文档符号
     */
    private async getDocumentSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[]> {
        try {
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                uri
            );
            return symbols || [];
        } catch (error) {
            console.error('[IJump] 获取文档符号失败:', error);
            return [];
        }
    }

    /**
     * 查找实现
     */
    private async findImplementations(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
        try {
            const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeImplementationProvider',
                uri,
                position
            );
            return locations || [];
        } catch (error) {
            console.error('[IJump] 查找实现失败:', error);
            return [];
        }
    }

    /**
     * 查找类型定义
     */
    private async findTypeDefinition(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
        try {
            const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeTypeDefinitionProvider',
                uri,
                position
            );
            return locations || [];
        } catch (error) {
            console.error('[IJump] 查找类型定义失败:', error);
            return [];
        }
    }

    /**
     * 从文档符号中提取接口信息
     */
    private extractInterfaces(symbols: vscode.DocumentSymbol[], uri: vscode.Uri): InterfaceInfo[] {
        const interfaces: InterfaceInfo[] = [];

        for (const symbol of symbols) {
            if (symbol.kind === vscode.SymbolKind.Interface) {
                const methods: MethodInfo[] = [];

                // 提取接口方法
                if (symbol.children) {
                    for (const child of symbol.children) {
                        if (child.kind === vscode.SymbolKind.Method ||
                            child.kind === vscode.SymbolKind.Function) {
                            methods.push({
                                name: child.name,
                                line: child.selectionRange.start.line,
                                uri: uri
                            });
                        }
                    }
                }

                interfaces.push({
                    name: symbol.name,
                    line: symbol.selectionRange.start.line,
                    uri: uri,
                    methods: methods
                });
            }
        }

        return interfaces;
    }

    /**
     * 从文档符号中提取结构体和方法
     */
    private extractStructsAndMethods(symbols: vscode.DocumentSymbol[], uri: vscode.Uri): {
        structs: StructInfo[];
        methods: MethodInfo[];
    } {
        const structs: StructInfo[] = [];
        const methods: MethodInfo[] = [];

        for (const symbol of symbols) {
            // 结构体
            if (symbol.kind === vscode.SymbolKind.Struct ||
                symbol.kind === vscode.SymbolKind.Class) {
                const structMethods: MethodInfo[] = [];

                if (symbol.children) {
                    for (const child of symbol.children) {
                        if (child.kind === vscode.SymbolKind.Method) {
                            structMethods.push({
                                name: child.name,
                                line: child.selectionRange.start.line,
                                uri: uri,
                                receiverType: symbol.name
                            });
                        }
                    }
                }

                structs.push({
                    name: symbol.name,
                    line: symbol.selectionRange.start.line,
                    uri: uri,
                    methods: structMethods
                });
            }

            // 独立方法（带接收器的方法）
            if (symbol.kind === vscode.SymbolKind.Method) {
                // 方法名格式通常是 "(*StructName).MethodName" 或 "(StructName).MethodName"
                const match = symbol.name.match(/^\(?\*?(\w+)\)?\.(\w+)$/);
                if (match) {
                    methods.push({
                        name: match[2],
                        line: symbol.selectionRange.start.line,
                        uri: uri,
                        receiverType: match[1],
                        isPointer: symbol.name.includes('*')
                    });
                } else {
                    methods.push({
                        name: symbol.name,
                        line: symbol.selectionRange.start.line,
                        uri: uri
                    });
                }
            }
        }

        return { structs, methods };
    }

    /**
     * 获取接口装饰信息
     */
    async getInterfaceDecorations(document: vscode.TextDocument): Promise<DecorationInfo[]> {
        const allDecorations = await this.getAllDecorations(document);
        return allDecorations.interfaceDecorations;
    }

    /**
     * 获取实现装饰信息
     */
    async getImplementationDecorations(document: vscode.TextDocument): Promise<DecorationInfo[]> {
        const allDecorations = await this.getAllDecorations(document);
        return allDecorations.implementationDecorations;
    }

    /**
     * 获取所有装饰信息
     */
    async getAllDecorations(document: vscode.TextDocument): Promise<{
        interfaceDecorations: DecorationInfo[];
        implementationDecorations: DecorationInfo[];
        lineToMethodMap: Map<number, string>;
        lineTypeMap: Map<number, 'interface' | 'implementation'>;
    }> {
        const docKey = document.uri.toString();
        const now = Date.now();

        // 检查缓存
        const cached = this.decorationCache.get(docKey);
        if (cached && (now - cached.timestamp) < this.cacheTTL) {
            return cached;
        }

        const interfaceDecorations: DecorationInfo[] = [];
        const implementationDecorations: DecorationInfo[] = [];
        const lineToMethodMap = new Map<number, string>();
        const lineTypeMap = new Map<number, 'interface' | 'implementation'>();

        try {
            // 获取文档符号
            const symbols = await this.getDocumentSymbols(document.uri);

            if (!symbols || symbols.length === 0) {
                return { interfaceDecorations, implementationDecorations, lineToMethodMap, lineTypeMap };
            }

            // 提取接口和结构体信息
            const interfaces = this.extractInterfaces(symbols, document.uri);
            const { structs, methods } = this.extractStructsAndMethods(symbols, document.uri);

            // 为每个接口检查是否有实现
            for (const iface of interfaces) {
                const position = new vscode.Position(iface.line, 0);
                const implementations = await this.findImplementations(document.uri, position);

                if (implementations && implementations.length > 0) {
                    // 接口有实现，添加装饰
                    interfaceDecorations.push({
                        line: iface.line,
                        type: 'interface',
                        name: iface.name
                    });
                    lineToMethodMap.set(iface.line, iface.name);
                    lineTypeMap.set(iface.line, 'interface');

                    // 为接口方法也添加装饰
                    for (const method of iface.methods) {
                        interfaceDecorations.push({
                            line: method.line,
                            type: 'interface',
                            name: method.name
                        });
                        lineToMethodMap.set(method.line, method.name);
                        lineTypeMap.set(method.line, 'interface');
                    }
                }
            }

            // 为每个方法检查是否实现了接口
            const allMethods = [...methods];
            for (const struct of structs) {
                allMethods.push(...struct.methods);
            }

            for (const method of allMethods) {
                const position = new vscode.Position(method.line, 0);
                const typeDefinitions = await this.findTypeDefinition(document.uri, position);

                if (typeDefinitions && typeDefinitions.length > 0) {
                    // 方法实现了接口
                    implementationDecorations.push({
                        line: method.line,
                        type: 'implementation',
                        name: method.name
                    });
                    lineToMethodMap.set(method.line, method.name);
                    lineTypeMap.set(method.line, 'implementation');
                }
            }

            // 更新缓存
            const result = {
                interfaceDecorations,
                implementationDecorations,
                lineToMethodMap,
                lineTypeMap,
                timestamp: now
            };
            this.decorationCache.set(docKey, result);

            return result;
        } catch (error) {
            console.error('[IJump] gopls 获取装饰信息失败:', error);
            return { interfaceDecorations, implementationDecorations, lineToMethodMap, lineTypeMap };
        }
    }

    /**
     * 清除缓存
     */
    clearCache(filePath?: string): void {
        if (filePath) {
            const uri = vscode.Uri.file(filePath);
            this.decorationCache.delete(uri.toString());
        } else {
            this.decorationCache.clear();
        }
        this.checkPromise = null;
        console.log('[IJump] gopls 缓存已清除');
    }
}
