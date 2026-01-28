import * as vscode from 'vscode';
import { IParserService, DecorationInfo, InterfaceInfo, StructInfo, MethodInfo, CommentImplementation, JumpTarget } from './parserInterface';

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
     * 从文档文本中解析 "ensure X implements Y" 格式的注释声明
     * 返回一个 Map，key 是结构体名，value 是实现的接口列表
     */
    private parseImplementsComments(document: vscode.TextDocument): Map<string, string[]> {
        const implementsMap = new Map<string, string[]>();
        const text = document.getText();

        // 匹配注释中的 ensure X implements Y 格式
        // 支持多种格式:
        // - // ensure StructName implements InterfaceName
        // - // ensure StructName implements Interface1, Interface2
        // - /* ensure StructName implements InterfaceName */
        // - // StructName implements InterfaceName
        const patterns = [
            // 完整格式: ensure X implements Y
            /\/\/\s*ensure\s+(\w+)\s+implements\s+([\w,\s]+)/gi,
            /\/\*\s*ensure\s+(\w+)\s+implements\s+([\w,\s]+)\s*\*\//gi,
            // 简化格式: X implements Y (在注释中)
            /\/\/\s*(\w+)\s+implements\s+([\w,\s]+)/gi,
        ];

        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(text)) !== null) {
                const structName = match[1].trim();
                const interfacesPart = match[2];

                // 解析接口列表
                const interfaces = interfacesPart
                    .split(',')
                    .map(s => s.trim())
                    .filter(s => s.length > 0 && /^[A-Za-z_]\w*$/.test(s));

                if (interfaces.length > 0) {
                    const existing = implementsMap.get(structName) || [];
                    implementsMap.set(structName, [...existing, ...interfaces]);
                    console.log(`[IJump] gopls: 发现注释声明: ${structName} implements ${interfaces.join(', ')}`);
                }
            }
        }

        return implementsMap;
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

            // 解析注释中的接口实现声明
            const commentImplements = this.parseImplementsComments(document);

            // 创建接口名到方法名的映射
            const interfaceMethodNames = new Map<string, Set<string>>();
            for (const iface of interfaces) {
                const methodNames = new Set<string>();
                for (const method of iface.methods) {
                    methodNames.add(method.name);
                }
                interfaceMethodNames.set(iface.name, methodNames);
            }

            for (const method of allMethods) {
                const position = new vscode.Position(method.line, 0);
                const typeDefinitions = await this.findTypeDefinition(document.uri, position);

                // 仅当 gopls 能检测到类型定义时，才添加实现装饰
                // 对于仅注释声明的接口实现，不在方法上显示装饰
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

            // 为通过注释声明但 gopls 未检测到的接口添加装饰
            for (const [structName, declaredInterfaces] of commentImplements.entries()) {
                for (const ifaceName of declaredInterfaces) {
                    // 检查该接口是否存在于当前文档
                    const iface = interfaces.find(i => i.name === ifaceName);
                    if (iface) {
                        // 1. 接口定义行装饰
                        if (!interfaceDecorations.some(d => d.line === iface.line)) {
                            interfaceDecorations.push({
                                line: iface.line,
                                type: 'interface',
                                name: iface.name
                            });
                            lineToMethodMap.set(iface.line, iface.name);
                            lineTypeMap.set(iface.line, 'interface');
                        }

                        // 2. 接口方法装饰 - 仅当方法被该结构体实现时显示
                        for (const method of iface.methods) {
                            // 检查当前文档中的方法，看是否有属于该结构体且名称匹配的方法
                            const isImplemented = allMethods.some(m =>
                                (m.receiverType === structName || m.receiverType === `*${structName}`) &&
                                m.name === method.name
                            );

                            if (isImplemented && !interfaceDecorations.some(d => d.line === method.line)) {
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

                    // 3. 为结构体方法添加实现装饰 (如果是当前文档的方法)
                    for (const method of allMethods) {
                        if ((method.receiverType === structName || method.receiverType === `*${structName}`) &&
                            iface && iface.methods.some(m => m.name === method.name)) {

                            if (!implementationDecorations.some(d => d.line === method.line)) {
                                implementationDecorations.push({
                                    line: method.line,
                                    type: 'implementation',
                                    name: method.name
                                });
                                lineToMethodMap.set(method.line, method.name);
                                lineTypeMap.set(method.line, 'implementation');
                            }
                        }
                    }
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

    /**
     * 获取注释声明的接口实现关系
     * 返回 Map: 接口名 -> 实现该接口的结构体列表
     */
    async getCommentImplementations(document: vscode.TextDocument): Promise<Map<string, CommentImplementation[]>> {
        const result = new Map<string, CommentImplementation[]>();

        try {
            const text = document.getText();
            const symbols = await this.getDocumentSymbols(document.uri);

            // 创建结构体名和接口名到行号及 URI 的映射
            const structLines = new Map<string, number>();
            const interfaceInfos = new Map<string, { line: number, uri: vscode.Uri }>();

            const extractedInterfaces = this.extractInterfaces(symbols, document.uri);
            for (const iface of extractedInterfaces) {
                interfaceInfos.set(iface.name, { line: iface.line, uri: iface.uri });
            }

            for (const symbol of symbols) {
                if (symbol.kind === vscode.SymbolKind.Struct || symbol.kind === vscode.SymbolKind.Class) {
                    structLines.set(symbol.name, symbol.selectionRange.start.line);
                }
            }

            // 解析注释中的 ensure X implements Y 格式
            const patterns = [
                /\/\/\s*ensure\s+(\w+)\s+implements\s+([\w,\s]+)/gi,
                /\/\*\s*ensure\s+(\w+)\s+implements\s+([\w,\s]+)\s*\*\//gi,
                /\/\/\s*(\w+)\s+implements\s+([\w,\s]+)/gi,
            ];

            for (const pattern of patterns) {
                let match;
                while ((match = pattern.exec(text)) !== null) {
                    const structName = match[1].trim();
                    const interfacesPart = match[2];

                    // 获取结构体的行号
                    const structLine = structLines.get(structName);
                    if (structLine === undefined) {
                        continue;
                    }

                    // 解析接口列表
                    const interfaces = interfacesPart
                        .split(',')
                        .map(s => s.trim())
                        .filter(s => s.length > 0 && /^[A-Za-z_]\w*$/.test(s));

                    for (const interfaceName of interfaces) {
                        const ifaceInfo = interfaceInfos.get(interfaceName);

                        const impl: CommentImplementation = {
                            interfaceName: interfaceName,
                            structName: structName,
                            structLine: structLine,
                            structUri: document.uri,
                            interfaceLine: ifaceInfo?.line ?? 0,
                            interfaceUri: ifaceInfo?.uri ?? document.uri
                        };

                        if (!result.has(interfaceName)) {
                            result.set(interfaceName, []);
                        }
                        result.get(interfaceName)!.push(impl);
                    }
                }
            }

            return result;
        } catch (error) {
            console.error('[IJump] gopls 获取注释实现关系失败:', error);
            return result;
        }
    }

    /**
     * 获取指定行号的实现跳转目标（支持注释声明）
     */
    async getImplementationTargets(document: vscode.TextDocument, line: number): Promise<JumpTarget[]> {
        const targets: JumpTarget[] = [];

        try {
            const decs = await this.getAllDecorations(document);
            if (!decs) {
                return targets;
            }

            const name = decs.lineToMethodMap.get(line);
            if (!name) {
                return targets;
            }

            // 获取当前文档的所有解析信息
            const symbols = await this.getDocumentSymbols(document.uri);
            const interfaces = this.extractInterfaces(symbols, document.uri);
            const { structs, methods } = this.extractStructsAndMethods(symbols, document.uri);
            const commentImpls = await this.getCommentImplementations(document);

            // 合并所有方法以便查找
            const allMethods = [...methods];
            for (const s of structs) {
                allMethods.push(...s.methods);
            }

            // 1. 如果点击的是接口定义行
            if (commentImpls.has(name)) {
                const impls = commentImpls.get(name)!;
                for (const impl of impls) {
                    targets.push({
                        uri: impl.structUri,
                        line: impl.structLine,
                        name: impl.structName
                    });
                }
                return targets;
            }

            // 2. 如果点击的是接口方法行
            const iface = interfaces.find(i => i.methods.some(m => m.line === line && m.name === name));
            if (iface) {
                const impls = commentImpls.get(iface.name);
                if (impls) {
                    for (const impl of impls) {
                        // 在当前文档中查找属于该结构体的同名方法
                        const methodImpl = allMethods.find(m =>
                            (m.receiverType === impl.structName || m.receiverType === `*${impl.structName}`) &&
                            m.name === name
                        );

                        if (methodImpl) {
                            targets.push({
                                uri: methodImpl.uri,
                                line: methodImpl.line,
                                name: `${impl.structName}.${methodImpl.name}`
                            });
                        }
                    }
                }
            }

            return targets;
        } catch (error) {
            console.error('[IJump] gopls 获取跳转目标失败:', error);
            return targets;
        }
    }

    /**
     * 获取指定行号的接口跳转目标（支持从实现跳转回接口）
     */
    async getInterfaceTargets(document: vscode.TextDocument, line: number): Promise<JumpTarget[]> {
        const targets: JumpTarget[] = [];

        try {
            const decs = await this.getAllDecorations(document);
            if (!decs) {
                return targets;
            }

            const name = decs.lineToMethodMap.get(line);
            if (!name) {
                return targets;
            }

            const symbols = await this.getDocumentSymbols(document.uri);
            const interfaces = this.extractInterfaces(symbols, document.uri);
            const { structs, methods } = this.extractStructsAndMethods(symbols, document.uri);
            const commentImpls = await this.getCommentImplementations(document);

            const allMethods = [...methods];
            for (const s of structs) {
                allMethods.push(...s.methods);
            }

            // 1. 判断该行是否是结构体定义行
            const struct = structs.find(s => s.line === line && s.name === name);
            if (struct) {
                // 查找该结构体实现的接口
                for (const [ifaceName, impls] of commentImpls.entries()) {
                    if (impls.some(impl => impl.structName === struct.name)) {
                        // 寻找对应接口的定义 (可能在同一个文件或缓存中)
                        // 注意：gopls 模式下 interfaces 只包含当前文件的
                        const iface = interfaces.find(i => i.name === ifaceName);
                        if (iface) {
                            targets.push({
                                uri: iface.uri,
                                line: iface.line,
                                name: iface.name
                            });
                        } else {
                            // 如果当前文档没找到，可以尝试通过 commentImpls 中的信息（如果有位置信息）
                            const impl = impls.find(i => i.structName === struct.name);
                            if (impl) {
                                // 假设接口也在当前项目可见范围内，尝试直接定位
                                targets.push({
                                    uri: impl.interfaceUri,
                                    line: impl.interfaceLine,
                                    name: ifaceName
                                });
                            }
                        }
                    }
                }
                return targets;
            }

            // 2. 判断该行是否是结构体方法定义行
            const method = allMethods.find(m => m.line === line && m.name === name);
            if (method && method.receiverType) {
                const receiverName = method.receiverType.startsWith('*') ? method.receiverType.substring(1) : method.receiverType;

                for (const [ifaceName, impls] of commentImpls.entries()) {
                    if (impls.some(impl => impl.structName === receiverName)) {
                        // 查找接口是否包含该方法
                        const iface = interfaces.find(i => i.name === ifaceName);
                        if (iface) {
                            const ifaceMethod = iface.methods.find(m => m.name === name);
                            if (ifaceMethod) {
                                targets.push({
                                    uri: ifaceMethod.uri,
                                    line: ifaceMethod.line,
                                    name: `${ifaceName}.${ifaceMethod.name}`
                                });
                            }
                        } else {
                            // 回退逻辑：查找该接口的实现信息以获取接口 URI
                            const impl = impls.find(i => i.structName === receiverName);
                            if (impl) {
                                targets.push({
                                    uri: impl.interfaceUri,
                                    line: impl.interfaceLine, // 只能跳转到接口定义
                                    name: ifaceName
                                });
                            }
                        }
                    }
                }
            }

            return targets;
        } catch (error) {
            console.error('[IJump] gopls 获取接口跳转目标失败:', error);
            return targets;
        }
    }
}
