import * as vscode from 'vscode';

/**
 * 接口信息
 */
export interface InterfaceInfo {
    name: string;
    range: vscode.Range;
    uri: vscode.Uri;
    methods: MethodInfo[];
}

/**
 * 方法信息
 */
export interface MethodInfo {
    name: string;
    range: vscode.Range;
    uri: vscode.Uri;
    parentName?: string; // 所属接口或结构体名称
}

/**
 * 结构体信息
 */
export interface StructInfo {
    name: string;
    range: vscode.Range;
    uri: vscode.Uri;
    methods: MethodInfo[];
}

/**
 * GoplsService - 使用 VS Code 内置 LSP API 与 gopls 交互
 * 
 * 这个服务类封装了 VS Code 的语言服务器协议 API，
 * 底层由 Go 扩展的 gopls 语言服务器提供支持。
 */
export class GoplsService {
    private isReady: boolean = false;
    private checkPromise: Promise<boolean> | null = null;

    /**
     * 检查 gopls 是否可用
     * 通过检测 Go 扩展是否已激活来判断
     */
    async isGoplsAvailable(): Promise<boolean> {
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
                await goExtension.activate();
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
     * 使用 VS Code 的 executeDocumentSymbolProvider 命令
     */
    async getDocumentSymbols(uri: vscode.Uri): Promise<vscode.DocumentSymbol[]> {
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
     * 使用 VS Code 的 executeImplementationProvider 命令
     */
    async findImplementations(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
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
     * 使用 VS Code 的 executeTypeDefinitionProvider 命令
     */
    async findTypeDefinition(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
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
    extractInterfaces(symbols: vscode.DocumentSymbol[], uri: vscode.Uri): InterfaceInfo[] {
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
                                range: child.selectionRange,
                                uri: uri,
                                parentName: symbol.name
                            });
                        }
                    }
                }

                interfaces.push({
                    name: symbol.name,
                    range: symbol.selectionRange,
                    uri: uri,
                    methods: methods
                });
            }
        }

        return interfaces;
    }

    /**
     * 从文档符号中提取结构体及其方法
     */
    extractStructsAndMethods(symbols: vscode.DocumentSymbol[], uri: vscode.Uri): {
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
                                range: child.selectionRange,
                                uri: uri,
                                parentName: symbol.name
                            });
                        }
                    }
                }

                structs.push({
                    name: symbol.name,
                    range: symbol.selectionRange,
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
                        range: symbol.selectionRange,
                        uri: uri,
                        parentName: match[1]
                    });
                } else {
                    methods.push({
                        name: symbol.name,
                        range: symbol.selectionRange,
                        uri: uri
                    });
                }
            }
        }

        return { structs, methods };
    }

    /**
     * 检查一个方法是否实现了某个接口
     */
    async isMethodImplementingInterface(
        methodUri: vscode.Uri,
        methodPosition: vscode.Position
    ): Promise<boolean> {
        const typeDefinitions = await this.findTypeDefinition(methodUri, methodPosition);

        // 如果有类型定义，说明这个方法实现了某个接口
        return typeDefinitions.length > 0;
    }

    /**
     * 检查接口是否有实现
     */
    async hasImplementations(
        interfaceUri: vscode.Uri,
        interfacePosition: vscode.Position
    ): Promise<boolean> {
        const implementations = await this.findImplementations(interfaceUri, interfacePosition);
        return implementations.length > 0;
    }

    /**
     * 清除缓存（保留接口兼容性）
     */
    clearCache(): void {
        // gopls 自己管理缓存，这里只是为了保持 API 兼容性
        this.checkPromise = null;
        console.log('[IJump] 缓存已清除');
    }
}
