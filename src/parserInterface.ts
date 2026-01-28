import * as vscode from 'vscode';

/**
 * 接口信息
 */
export interface InterfaceInfo {
    name: string;
    line: number;
    uri: vscode.Uri;
    methods: MethodInfo[];
}

/**
 * 结构体信息
 */
export interface StructInfo {
    name: string;
    line: number;
    uri: vscode.Uri;
    methods: MethodInfo[];
}

/**
 * 方法信息
 */
export interface MethodInfo {
    name: string;
    line: number;
    uri: vscode.Uri;
    receiverType?: string;
    isPointer?: boolean;
}

/**
 * 装饰信息
 */
export interface DecorationInfo {
    line: number;
    type: 'interface' | 'implementation';
    name: string;
}

/**
 * 注释声明的接口实现关系
 */
export interface CommentImplementation {
    interfaceName: string;
    structName: string;
    structLine: number;
    structUri: vscode.Uri;
    interfaceLine: number;
    interfaceUri: vscode.Uri;
}

/**
 * 跳转目标信息
 */
export interface JumpTarget {
    uri: vscode.Uri;
    line: number;
    name: string;
}

/**
 * 解析结果
 */
export interface ParseResult {
    interfaces: InterfaceInfo[];
    structs: StructInfo[];
    methods: MethodInfo[];
    implementedInterfaces: Set<string>;
}

/**
 * 统一的解析服务接口
 * GoAstParser 和 GoplsService 都实现此接口
 */
export interface IParserService {
    /**
     * 检查服务是否可用
     */
    isAvailable(): Promise<boolean>;

    /**
     * 获取接口装饰信息
     */
    getInterfaceDecorations(document: vscode.TextDocument): Promise<DecorationInfo[]>;

    /**
     * 获取实现装饰信息
     */
    getImplementationDecorations(document: vscode.TextDocument): Promise<DecorationInfo[]>;

    /**
     * 获取所有装饰信息（接口 + 实现）
     */
    getAllDecorations(document: vscode.TextDocument): Promise<{
        interfaceDecorations: DecorationInfo[];
        implementationDecorations: DecorationInfo[];
        lineToMethodMap: Map<number, string>;
        lineTypeMap: Map<number, 'interface' | 'implementation'>;
    }>;

    /**
     * 获取注释声明的接口实现关系
     * 返回 Map: 接口名 -> 实现该接口的结构体列表
     */
    getCommentImplementations(document: vscode.TextDocument): Promise<Map<string, CommentImplementation[]>>;

    /**
     * 获取指定行号的实现跳转目标（支持注释声明）
     */
    getImplementationTargets(document: vscode.TextDocument, line: number): Promise<JumpTarget[]>;

    /**
     * 获取指定行号的接口跳转目标（支持从实现跳转回接口）
     */
    getInterfaceTargets(document: vscode.TextDocument, line: number): Promise<JumpTarget[]>;

    /**
     * 清除缓存
     */
    clearCache(filePath?: string): void;

    /**
     * 获取服务名称（用于显示）
     */
    getServiceName(): string;
}

