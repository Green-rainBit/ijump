// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';
import { GoplsService } from './goplsService';

// 定义装饰类
class DecorationManager {
	private interfaceDecorationType: vscode.TextEditorDecorationType;
	private implementationDecorationType: vscode.TextEditorDecorationType;

	constructor(context: vscode.ExtensionContext) {
		const interfaceIconPath = path.join(context.extensionPath, 'resources', 'interface.svg');
		const implementationIconPath = path.join(context.extensionPath, 'resources', 'implementation.svg');

		// 接口方法装饰（跳转到实现）
		this.interfaceDecorationType = vscode.window.createTextEditorDecorationType({
			gutterIconPath: interfaceIconPath,
			gutterIconSize: '60%',
			isWholeLine: false
		});

		// 实现方法装饰（跳转到接口）
		this.implementationDecorationType = vscode.window.createTextEditorDecorationType({
			gutterIconPath: implementationIconPath,
			gutterIconSize: '60%',
			isWholeLine: false
		});
	}

	// 获取接口装饰类型
	getInterfaceDecorationType(): vscode.TextEditorDecorationType {
		return this.interfaceDecorationType;
	}

	// 获取实现装饰类型
	getImplementationDecorationType(): vscode.TextEditorDecorationType {
		return this.implementationDecorationType;
	}

	// 应用装饰
	applyDecorations(editor: vscode.TextEditor,
		interfaceDecorations: vscode.DecorationOptions[],
		implementationDecorations: vscode.DecorationOptions[]) {
		editor.setDecorations(this.interfaceDecorationType, interfaceDecorations);
		editor.setDecorations(this.implementationDecorationType, implementationDecorations);
		console.log(`[IJump] 应用了 ${interfaceDecorations.length} 个接口装饰和 ${implementationDecorations.length} 个实现装饰`);
	}

	// 清除装饰
	clearDecorations(editor: vscode.TextEditor) {
		editor.setDecorations(this.interfaceDecorationType, []);
		editor.setDecorations(this.implementationDecorationType, []);
	}
}

// 缓存管理类
class CacheManager {
	private lineToMethodMap = new Map<string, Map<number, string>>();
	private lineTypeMap = new Map<string, Map<number, 'interface' | 'implementation'>>();
	private decoratedLines = new Map<string, Set<number>>();

	// 更新方法映射
	updateMethodMap(docKey: string, methodMap: Map<number, string>) {
		this.lineToMethodMap.set(docKey, methodMap);
	}

	// 更新行类型映射
	updateLineTypeMap(docKey: string, lineTypes: Map<number, 'interface' | 'implementation'>) {
		this.lineTypeMap.set(docKey, lineTypes);
	}

	// 更新装饰行集合
	updateDecoratedLines(docKey: string, decoratedLines: Set<number>) {
		this.decoratedLines.set(docKey, decoratedLines);
	}

	// 获取方法映射
	getMethodMap(docKey: string): Map<number, string> | undefined {
		return this.lineToMethodMap.get(docKey);
	}

	// 获取行类型映射
	getLineTypeMap(docKey: string): Map<number, 'interface' | 'implementation'> | undefined {
		return this.lineTypeMap.get(docKey);
	}

	// 获取装饰行集合
	getDecoratedLines(docKey: string): Set<number> | undefined {
		return this.decoratedLines.get(docKey);
	}

	// 清除缓存
	clear() {
		this.lineToMethodMap.clear();
		this.lineTypeMap.clear();
		this.decoratedLines.clear();
	}
}

// CodeLens 提供者 - 用于在行首添加可点击的链接
class IJumpCodeLensProvider implements vscode.CodeLensProvider {
	private cacheManager: CacheManager;
	private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
	public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

	constructor(cacheManager: CacheManager) {
		this.cacheManager = cacheManager;
	}

	// 刷新 CodeLens
	refresh(): void {
		this._onDidChangeCodeLenses.fire();
	}

	provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.CodeLens[] {
		if (document.languageId !== 'go') {
			return [];
		}

		const codeLenses: vscode.CodeLens[] = [];
		const docKey = document.uri.toString();
		const decoratedLines = this.cacheManager.getDecoratedLines(docKey);
		const lineTypes = this.cacheManager.getLineTypeMap(docKey);
		const methodMap = this.cacheManager.getMethodMap(docKey);

		if (!decoratedLines || !lineTypes || !methodMap) {
			return [];
		}

		for (const line of decoratedLines) {
			const lineType = lineTypes.get(line);
			const methodName = methodMap.get(line);

			if (!lineType || !methodName) {
				continue;
			}

			const range = new vscode.Range(line, 0, line, 0);

			if (lineType === 'interface') {
				// 接口 - 跳转到实现
				codeLenses.push(new vscode.CodeLens(range, {
					title: '➡️ 实现',
					command: 'ijump.jumpToImplementation',
					arguments: [document.uri, line]
				}));
			} else if (lineType === 'implementation') {
				// 实现 - 跳转到接口
				codeLenses.push(new vscode.CodeLens(range, {
					title: '⬆️ 接口',
					command: 'ijump.jumpToInterface',
					arguments: [document.uri, line]
				}));
			}
		}

		return codeLenses;
	}
}

// 主扩展管理类
class IJumpExtension {
	private goplsService: GoplsService;
	private decorationManager: DecorationManager;
	private cacheManager: CacheManager;
	private codeLensProvider: IJumpCodeLensProvider;
	private updateThrottleTimer: NodeJS.Timeout | null = null;
	private throttleDelay: number = 200; // 减少到200毫秒节流延迟
	private lastAnalyzedFile: string = '';
	private isUpdating: boolean = false;

	constructor(private context: vscode.ExtensionContext) {
		this.goplsService = new GoplsService();
		this.decorationManager = new DecorationManager(context);
		this.cacheManager = new CacheManager();
		this.codeLensProvider = new IJumpCodeLensProvider(this.cacheManager);

		this.registerCommands();
		this.registerEventListeners();
		this.registerFileWatcher();
		this.registerCodeLensProvider();
	}

	// 注册 CodeLens 提供者
	private registerCodeLensProvider() {
		this.context.subscriptions.push(
			vscode.languages.registerCodeLensProvider(
				{ language: 'go', scheme: 'file' },
				this.codeLensProvider
			)
		);
	}

	async initialize() {
		console.log('[IJump] 正在初始化...');

		// 检查 gopls 是否可用
		const isAvailable = await this.goplsService.isGoplsAvailable();

		if (!isAvailable) {
			const installGo = '安装 Go 扩展';
			const result = await vscode.window.showWarningMessage(
				'[IJump] 未检测到 Go 扩展。接口跳转功能需要 Go 扩展 (golang.Go) 提供的 gopls 支持。',
				installGo
			);

			if (result === installGo) {
				vscode.commands.executeCommand('workbench.extensions.search', 'golang.Go');
			}
			return;
		}

		console.log('[IJump] gopls 服务已就绪');

		// 处理当前打开的编辑器
		if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.languageId === 'go') {
			// 等待一小段时间让 gopls 完全启动
			setTimeout(() => {
				if (vscode.window.activeTextEditor) {
					this.updateDecorations(vscode.window.activeTextEditor);
					this.lastAnalyzedFile = vscode.window.activeTextEditor.document.uri.fsPath;
				}
			}, 1000);
		}
	}

	// 跳转到接口定义
	private async jumpToInterface(uri: vscode.Uri, line: number) {
		try {
			console.log(`[IJump] 准备跳转到接口: 行 ${line}`);
			const document = await vscode.workspace.openTextDocument(uri);
			const editor = await vscode.window.showTextDocument(document);

			// 获取方法名
			const docKey = document.uri.toString();
			const methodMap = this.cacheManager.getMethodMap(docKey);
			const methodName = methodMap?.get(line);
			console.log(`[IJump] 实现方法名: ${methodName}`);

			if (!methodName) {
				console.error('[IJump] 未找到方法名');
				vscode.window.showErrorMessage('未找到方法名');
				return;
			}

			// 获取行文本找到方法名的位置
			const lineText = document.lineAt(line).text;
			const methodNameIndex = lineText.indexOf(methodName);

			if (methodNameIndex >= 0) {
				// 定位光标到方法名上
				const position = new vscode.Position(line, methodNameIndex + Math.floor(methodName.length / 2));
				editor.selection = new vscode.Selection(position, position);
				editor.revealRange(new vscode.Range(position, position));
			}

			// 使用VS Code内置命令
			await vscode.commands.executeCommand('editor.action.goToTypeDefinition');
		} catch (error) {
			console.error('[IJump] 跳转失败:', error);
			vscode.window.showErrorMessage('无法跳转到接口方法');
		}
	}

	// 跳转到实现
	private async jumpToImplementation(uri: vscode.Uri, line: number) {
		try {
			console.log(`[IJump] 准备跳转到实现: 行 ${line}`);
			const document = await vscode.workspace.openTextDocument(uri);
			const editor = await vscode.window.showTextDocument(document);

			// 获取方法名
			const docKey = document.uri.toString();
			const methodMap = this.cacheManager.getMethodMap(docKey);
			const methodName = methodMap?.get(line);
			console.log(`[IJump] 接口方法名: ${methodName}`);

			if (!methodName) {
				console.error('[IJump] 未找到方法名');
				vscode.window.showErrorMessage('未找到方法名');
				return;
			}

			// 获取行文本找到方法名的位置
			const lineText = document.lineAt(line).text;
			const methodNameIndex = lineText.indexOf(methodName);

			if (methodNameIndex < 0) {
				console.error('[IJump] 在行中未找到方法名');
				vscode.window.showErrorMessage('在行中未找到方法名');
				return;
			}

			// 定位光标到方法名上
			const position = new vscode.Position(line, methodNameIndex + Math.floor(methodName.length / 2));
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(new vscode.Range(position, position));

			// 使用VS Code内置命令
			await vscode.commands.executeCommand('editor.action.goToImplementation');
		} catch (error) {
			console.error('[IJump] 跳转失败:', error);
			vscode.window.showErrorMessage('无法跳转到实现');
		}
	}

	// 更新装饰的节流函数
	private throttleUpdateDecorations(editor: vscode.TextEditor) {
		// 取消先前的更新计时器
		if (this.updateThrottleTimer) {
			clearTimeout(this.updateThrottleTimer);
		}

		// 设置新的延迟更新
		this.updateThrottleTimer = setTimeout(() => {
			this.updateDecorations(editor);
			this.updateThrottleTimer = null;
		}, this.throttleDelay);
	}

	// 更新装饰
	private async updateDecorations(editor: vscode.TextEditor) {
		if (!editor || editor.document.languageId !== 'go') {
			return;
		}

		// 避免并发更新
		if (this.isUpdating) {
			return;
		}
		this.isUpdating = true;

		const document = editor.document;
		const docKey = document.uri.toString();
		const uri = document.uri;

		// 准备数据结构
		const methodMap = new Map<number, string>();
		const lineTypes = new Map<number, 'interface' | 'implementation'>();
		const docDecoratedLines = new Set<number>();
		const interfaceDecorations: vscode.DecorationOptions[] = [];
		const implementationDecorations: vscode.DecorationOptions[] = [];

		try {
			// 获取文档符号
			const symbols = await this.goplsService.getDocumentSymbols(uri);

			if (!symbols || symbols.length === 0) {
				console.log('[IJump] 未找到文档符号，跳过装饰更新');
				this.isUpdating = false;
				return;
			}

			// 提取接口信息
			const interfaces = this.goplsService.extractInterfaces(symbols, uri);

			// 提取结构体和方法信息
			const { structs, methods } = this.goplsService.extractStructsAndMethods(symbols, uri);

			console.log(`[IJump] 找到 ${interfaces.length} 个接口, ${structs.length} 个结构体, ${methods.length} 个方法`);

			// 处理接口 - 检查是否有实现
			for (const iface of interfaces) {
				// 为接口定义添加装饰
				const hasImpl = await this.goplsService.hasImplementations(uri, iface.range.start);

				if (hasImpl) {
					// 接口定义
					const line = iface.range.start.line;
					interfaceDecorations.push({
						range: new vscode.Range(line, 0, line, 0)
					});
					methodMap.set(line, iface.name);
					lineTypes.set(line, 'interface');
					docDecoratedLines.add(line);

					// 接口方法
					for (const method of iface.methods) {
						const methodLine = method.range.start.line;
						interfaceDecorations.push({
							range: new vscode.Range(methodLine, 0, methodLine, 0)
						});
						methodMap.set(methodLine, method.name);
						lineTypes.set(methodLine, 'interface');
						docDecoratedLines.add(methodLine);
					}
				}
			}

			// 处理方法实现 - 检查是否实现了接口
			const allMethods = [...methods];

			// 也收集结构体内的方法
			for (const struct of structs) {
				allMethods.push(...struct.methods);
			}

			for (const method of allMethods) {
				const isImpl = await this.goplsService.isMethodImplementingInterface(uri, method.range.start);

				if (isImpl) {
					const line = method.range.start.line;
					implementationDecorations.push({
						range: new vscode.Range(line, 0, line, 0)
					});
					methodMap.set(line, method.name);
					lineTypes.set(line, 'implementation');
					docDecoratedLines.add(line);
				}
			}

			// 更新缓存
			this.cacheManager.updateMethodMap(docKey, methodMap);
			this.cacheManager.updateLineTypeMap(docKey, lineTypes);
			this.cacheManager.updateDecoratedLines(docKey, docDecoratedLines);

			// 应用装饰
			this.decorationManager.applyDecorations(editor, interfaceDecorations, implementationDecorations);

			// 刷新 CodeLens
			this.codeLensProvider.refresh();
		} catch (error) {
			console.error('[IJump] 更新装饰失败:', error);
		} finally {
			this.isUpdating = false;
		}
	}

	// 注册命令
	private registerCommands() {
		// 跳转到接口方法的命令
		this.context.subscriptions.push(
			vscode.commands.registerCommand('ijump.jumpToInterface', async (uri: vscode.Uri, line: number) => {
				await this.jumpToInterface(uri, line);
			})
		);

		// 跳转到实现的命令
		this.context.subscriptions.push(
			vscode.commands.registerCommand('ijump.jumpToImplementation', async (uri: vscode.Uri, line: number) => {
				await this.jumpToImplementation(uri, line);
			})
		);

		// 添加清除缓存命令
		this.context.subscriptions.push(
			vscode.commands.registerCommand('ijump.clearCache', () => {
				this.goplsService.clearCache();
				this.cacheManager.clear();
				vscode.window.showInformationMessage('IJump: 已清除所有缓存');

				// 如果当前有活动编辑器，更新装饰
				if (vscode.window.activeTextEditor) {
					this.throttleUpdateDecorations(vscode.window.activeTextEditor);
				}
			})
		);
	}

	// 注册事件监听器
	private registerEventListeners() {
		// 监听编辑器变化
		this.context.subscriptions.push(
			vscode.window.onDidChangeActiveTextEditor(editor => {
				if (editor && editor.document.languageId === 'go') {
					// 只在切换到不同文件时触发更新
					if (this.lastAnalyzedFile !== editor.document.uri.fsPath) {
						this.throttleUpdateDecorations(editor);
						this.lastAnalyzedFile = editor.document.uri.fsPath;
					}
				}
			})
		);

		// 监听文档保存 - 只在保存Go文件时更新
		this.context.subscriptions.push(
			vscode.workspace.onDidSaveTextDocument(document => {
				const editor = vscode.window.activeTextEditor;
				if (editor && document.languageId === 'go' && document === editor.document) {
					this.throttleUpdateDecorations(editor);
				}
			})
		);
	}

	// 监视Go文件变化
	private registerFileWatcher() {
		// 创建Go文件变更监视器
		const goFileWatcher = vscode.workspace.createFileSystemWatcher('**/*.go');

		// 监听文件创建
		this.context.subscriptions.push(
			goFileWatcher.onDidCreate(uri => {
				// 检查是否需要更新当前编辑器装饰
				const editor = vscode.window.activeTextEditor;
				if (editor && path.dirname(editor.document.uri.fsPath) === path.dirname(uri.fsPath)) {
					this.throttleUpdateDecorations(editor);
				}
			})
		);

		// 监听文件删除
		this.context.subscriptions.push(
			goFileWatcher.onDidDelete(uri => {
				// 检查是否需要更新当前编辑器装饰
				const editor = vscode.window.activeTextEditor;
				if (editor && path.dirname(editor.document.uri.fsPath) === path.dirname(uri.fsPath)) {
					this.throttleUpdateDecorations(editor);
				}
			})
		);

		// 添加到订阅列表
		this.context.subscriptions.push(goFileWatcher);
	}
}

// 激活扩展
export function activate(context: vscode.ExtensionContext) {
	console.log('[IJump] 扩展已激活!');

	// 创建并初始化扩展
	const extension = new IJumpExtension(context);
	extension.initialize();
}

// 停用扩展
export function deactivate() { }
