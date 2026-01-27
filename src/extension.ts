// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';
import { GoAstParser } from './goAstParser';
import { ParserManager } from './parserManager';
import { IJumpCodeLensProvider } from './codeLensProvider';
import * as fs from 'fs';

// 定义接口用于记录方法信息
interface MethodInfo {
	name: string;
	line: number;
	type: 'interface' | 'implementation';
}

// 添加新的接口用于存储文件信息
interface GoFileInfo {
	uri: vscode.Uri;
	packageName: string;
	content: string;
}

// 定义装饰类
// 定义装饰类
class DecorationManager {
	private interfaceDecorationType: vscode.TextEditorDecorationType | undefined;
	private implementationDecorationType: vscode.TextEditorDecorationType | undefined;
	private interfaceIconPath: string;
	private implementationIconPath: string;

	constructor(context: vscode.ExtensionContext) {
		this.interfaceIconPath = path.join(context.extensionPath, 'resources', 'interface.svg');
		this.implementationIconPath = path.join(context.extensionPath, 'resources', 'implementation.svg');
		this.configure();
	}

	// 配置装饰类型
	public configure() {
		// 清理旧的装饰类型
		if (this.interfaceDecorationType) {
			this.interfaceDecorationType.dispose();
		}
		if (this.implementationDecorationType) {
			this.implementationDecorationType.dispose();
		}

		const config = vscode.workspace.getConfiguration('ijump');
		const iconPosition = config.get<string>('iconPosition', 'gutter');

		if (iconPosition === 'inline') {
			// Inline 模式：使用 after 属性显示图标
			const interfaceIconUri = vscode.Uri.file(this.interfaceIconPath);
			const implementationIconUri = vscode.Uri.file(this.implementationIconPath);

			this.interfaceDecorationType = vscode.window.createTextEditorDecorationType({
				after: {
					contentIconPath: interfaceIconUri,
					margin: '0 0 0 5px',
					width: '14px',
					height: '14px'
				},
				isWholeLine: false
			});

			this.implementationDecorationType = vscode.window.createTextEditorDecorationType({
				after: {
					contentIconPath: implementationIconUri,
					margin: '0 0 0 5px',
					width: '14px',
					height: '14px'
				},
				isWholeLine: false
			});
		} else {
			// Gutter 模式：使用 gutterIconPath
			this.interfaceDecorationType = vscode.window.createTextEditorDecorationType({
				gutterIconPath: this.interfaceIconPath,
				gutterIconSize: '60%',
				isWholeLine: false
			});

			this.implementationDecorationType = vscode.window.createTextEditorDecorationType({
				gutterIconPath: this.implementationIconPath,
				gutterIconSize: '60%',
				isWholeLine: false
			});
		}
	}

	// 获取接口装饰类型
	getInterfaceDecorationType(): vscode.TextEditorDecorationType | undefined {
		return this.interfaceDecorationType;
	}

	// 获取实现装饰类型
	getImplementationDecorationType(): vscode.TextEditorDecorationType | undefined {
		return this.implementationDecorationType;
	}

	// 应用装饰
	applyDecorations(editor: vscode.TextEditor,
		interfaceDecorations: vscode.DecorationOptions[],
		implementationDecorations: vscode.DecorationOptions[]) {
		if (this.interfaceDecorationType) {
			editor.setDecorations(this.interfaceDecorationType, interfaceDecorations);
		}
		if (this.implementationDecorationType) {
			editor.setDecorations(this.implementationDecorationType, implementationDecorations);
		}
		console.log(`应用了 ${interfaceDecorations.length} 个接口装饰和 ${implementationDecorations.length} 个实现装饰`);
	}
}


// 装饰生成类
class DecorationGenerator {
	constructor(private parser: GoAstParser) { }

	// 生成接口装饰 - 使用AST解析器
	async generateInterfaceDecorations(currentDocument: vscode.TextDocument,
		implementedInterfaces: Set<string>,
		interfaceLocationsMap: Map<string, Map<string, { line: number, uri: vscode.Uri }>>): Promise<vscode.DecorationOptions[]> {
		const interfaceDecorations: vscode.DecorationOptions[] = [];

		// 只为当前文档生成装饰
		const currentDocUriString = currentDocument.uri.toString();

		for (const [interfaceName, methodLocations] of interfaceLocationsMap.entries()) {
			if (implementedInterfaces.has(interfaceName)) {
				// 为接口定义添加装饰
				const interfaceDefLocation = methodLocations.get('__interface_def__');
				if (interfaceDefLocation && interfaceDefLocation.uri.toString() === currentDocUriString) {
					const commandUri = vscode.Uri.parse(
						`command:ijump.jumpToImplementation?${encodeURIComponent(JSON.stringify([currentDocument.uri, interfaceDefLocation.line]))}`
					);
					const hoverMessage = new vscode.MarkdownString(`**接口**: ${interfaceName}\n\n[$(symbol-interface) 跳转到实现](${commandUri})`);
					hoverMessage.isTrusted = true;

					interfaceDecorations.push({
						range: new vscode.Range(
							new vscode.Position(interfaceDefLocation.line, 0),
							new vscode.Position(interfaceDefLocation.line, 0)
						),
						hoverMessage
					});
				}

				// 为接口方法添加装饰
				for (const [methodName, methodLocation] of methodLocations.entries()) {
					// 跳过接口定义特殊标记
					if (methodName === '__interface_def__') {
						continue;
					}

					// 只为当前文档中的方法添加装饰
					if (methodLocation.uri.toString() === currentDocUriString) {
						const commandUri = vscode.Uri.parse(
							`command:ijump.jumpToImplementation?${encodeURIComponent(JSON.stringify([currentDocument.uri, methodLocation.line]))}`
						);
						const hoverMessage = new vscode.MarkdownString(`**接口方法**: ${methodName}\n\n[$(symbol-interface) 跳转到实现](${commandUri})`);
						hoverMessage.isTrusted = true;

						interfaceDecorations.push({
							range: new vscode.Range(
								new vscode.Position(methodLocation.line, 0),
								new vscode.Position(methodLocation.line, 0)
							),
							hoverMessage
						});
					}
				}
			}
		}

		return interfaceDecorations;
	}

	// 生成实现装饰 - 使用AST解析器
	async generateImplementationDecorations(currentDocument: vscode.TextDocument,
		implementedInterfaces: Set<string>,
		interfaceMethodsMap: Map<string, string[]>,
		structMethodsMap: Map<string, Map<string, { line: number, uri: vscode.Uri }>>,
		structsMap: Map<string, Map<string, any>>): Promise<[vscode.DecorationOptions[], vscode.DecorationOptions[]]> {
		const implementationDecorations: vscode.DecorationOptions[] = [];
		const interfaceReferenceDecorations: vscode.DecorationOptions[] = [];

		// 只为当前文档生成装饰
		const currentDocUriString = currentDocument.uri.toString();

		// 创建一个集合，存储所有实现了接口的方法，带上结构体信息
		const interfaceImplementingMethods = new Map<string, Set<string>>();

		// 创建一个映射，记录每个结构体实现了哪些接口
		const structImplementedInterfaces = new Map<string, Set<string>>();

		// 记录实现了接口的方法和结构体
		for (const [interfaceName, interfaceMethods] of interfaceMethodsMap.entries()) {
			if (implementedInterfaces.has(interfaceName)) {
				// 对于每个方法名，创建一个实现它的结构体集合
				for (const method of interfaceMethods) {
					if (!interfaceImplementingMethods.has(method)) {
						interfaceImplementingMethods.set(method, new Set<string>());
					}
				}

				// 查找实现该接口的结构体
				for (const [structName, methodsMap] of structMethodsMap.entries()) {
					// 检查结构体是否实现了接口的所有方法
					let implementedAllMethods = true;
					const structMethodNames = new Set<string>();

					// 收集结构体方法名
					for (const methodName of methodsMap.keys()) {
						if (!methodName.startsWith('__')) {
							structMethodNames.add(methodName);
						}
					}

					// 验证所有接口方法是否都被实现
					for (const method of interfaceMethods) {
						if (!structMethodNames.has(method)) {
							implementedAllMethods = false;
							break;
						}
					}

					// 如果结构体完全实现了接口
					if (implementedAllMethods) {
						// 记录结构体实现的接口
						if (!structImplementedInterfaces.has(structName)) {
							structImplementedInterfaces.set(structName, new Set<string>());
						}
						structImplementedInterfaces.get(structName)!.add(interfaceName);

						// 添加该结构体到每个方法的实现集合
						for (const method of interfaceMethods) {
							interfaceImplementingMethods.get(method)!.add(structName);
						}
					}
				}
			}
		}

		// 为实现方法添加装饰，只有当方法所属的结构体实现了接口时
		for (const [structName, methodsMap] of structMethodsMap.entries()) {
			// 检查该结构体是否实现了任何接口
			if (!structImplementedInterfaces.has(structName)) {
				continue; // 如果结构体没有实现任何接口，则跳过
			}

			for (const [methodName, methodLocation] of methodsMap.entries()) {
				// 跳过特殊标记
				if (methodName.startsWith('__')) {
					continue;
				}

				// 检查该方法是否是接口方法实现
				if (interfaceImplementingMethods.has(methodName) &&
					interfaceImplementingMethods.get(methodName)!.has(structName) &&
					methodLocation.uri.toString() === currentDocUriString) {
					const commandUri = vscode.Uri.parse(
						`command:ijump.jumpToInterface?${encodeURIComponent(JSON.stringify([currentDocument.uri, methodLocation.line]))}`
					);
					const hoverMessage = new vscode.MarkdownString(`**实现**: ${methodName}\n\n[$(symbol-class) 跳转到接口定义](${commandUri})`);
					hoverMessage.isTrusted = true;

					implementationDecorations.push({
						range: new vscode.Range(
							new vscode.Position(methodLocation.line, 0),
							new vscode.Position(methodLocation.line, 0)
						),
						hoverMessage
					});
				}
			}
		}

		return [implementationDecorations, interfaceReferenceDecorations];
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
}

// 主扩展管理类
class IJumpExtension {
	private parser: GoAstParser;
	private parserManager: ParserManager;
	private decorationManager: DecorationManager;
	private decorationGenerator: DecorationGenerator;
	private cacheManager: CacheManager;
	private codeLensProvider: IJumpCodeLensProvider;
	private updateThrottleTimer: NodeJS.Timeout | null = null;
	private throttleDelay: number = 100; // 减少到100毫秒节流延迟
	private lastAnalyzedFile: string = ''; // 记录上次解析的文件路径

	constructor(private context: vscode.ExtensionContext) {
		this.parserManager = new ParserManager(context);
		this.parser = this.parserManager.getGoAstParser();
		this.decorationManager = new DecorationManager(context);
		this.decorationGenerator = new DecorationGenerator(this.parser);
		this.cacheManager = new CacheManager();
		this.codeLensProvider = new IJumpCodeLensProvider(this.parserManager);

		// 注册 CodeLens 提供者
		context.subscriptions.push(
			vscode.languages.registerCodeLensProvider('go', this.codeLensProvider)
		);

		this.registerCommands();
		this.registerEventListeners();
		this.registerFileWatcher();
	}

	/**
	 * 检查预编译解析器是否存在
	 */
	private async checkParser(): Promise<boolean> {
		// 检查两种可能的解析器文件名（有无.exe扩展名）
		const parserPath = path.join(this.context.extensionPath, 'src', 'parser', 'parser');
		const parserPathExe = path.join(this.context.extensionPath, 'src', 'parser', 'parser.exe');
		const exists = fs.existsSync(parserPath) || fs.existsSync(parserPathExe);

		if (!exists) {
			const message = '未找到预编译的Go解析器，接口跳转功能将不可用';
			const detail = '这可能是因为插件在打包时未能正确包含预编译的Go解析器。如果您是通过本地开发安装的插件，请尝试使用发布版本。';

			console.error(`[IJump] ${message}`);

			const goVersion = await this.checkGoEnvironment();
			if (goVersion) {
				const compile = '尝试编译';
				const result = await vscode.window.showErrorMessage(
					`[IJump] ${message}`,
					{ modal: false, detail },
					compile
				);

				if (result === compile) {
					const success = await this.parser.ensureParserReady();
					if (success) {
						vscode.window.showInformationMessage('[IJump] Go解析器编译成功');
						return true;
					} else {
						vscode.window.showErrorMessage('[IJump] Go解析器编译失败，接口跳转功能将不可用');
					}
				}
			} else {
				const installGo = '了解如何安装Go';
				const result = await vscode.window.showErrorMessage(
					`[IJump] ${message}。未检测到Go环境，接口跳转功能将不可用。`,
					{ modal: false, detail: detail + '\n\n要编译解析器，请安装Go编程语言。' },
					installGo
				);

				if (result === installGo) {
					vscode.env.openExternal(vscode.Uri.parse('https://golang.org/doc/install'));
				}
			}

			console.log('[IJump] 将以降级模式运行，部分功能可能不可用');
			return false;
		}

		return true;
	}

	/**
	 * 检查Go环境
	 */
	private async checkGoEnvironment(): Promise<string | null> {
		try {
			const { promisify } = require('util');
			const execFile = promisify(require('child_process').execFile);
			const { stdout } = await execFile('go', ['version']);
			return stdout.trim();
		} catch (e) {
			return null;
		}
	}

	initialize() {
		// 初始化解析器管理器
		this.parserManager.initialize().then(() => {
			console.log(`[IJump] 解析器模式: ${this.parserManager.getServiceName()}`);
		});

		// 检查解析器
		this.checkParser().then(exists => {
			if (exists) {
				console.log('[IJump] 预编译的Go解析器已就绪');

				// 处理当前打开的编辑器
				if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.languageId === 'go') {
					// 立即更新，不使用节流
					this.updateDecorations(vscode.window.activeTextEditor);
					this.lastAnalyzedFile = vscode.window.activeTextEditor.document.uri.fsPath;
				}
			}
		});
	}

	// 提供悬停信息
	private provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.Hover | null {
		const docKey = document.uri.toString();
		const methodMap = this.cacheManager.getMethodMap(docKey);
		const docDecoratedLines = this.cacheManager.getDecoratedLines(docKey);
		const lineTypes = this.cacheManager.getLineTypeMap(docKey);

		// 如果行没有被装饰，不显示悬停信息
		if (!methodMap || !methodMap.has(position.line) ||
			!docDecoratedLines || !docDecoratedLines.has(position.line) ||
			!lineTypes || !lineTypes.has(position.line)) {
			return null;
		}

		const methodName = methodMap.get(position.line)!;
		const lineType = lineTypes.get(position.line)!;
		const commandUri = `command:ijump.jumpToImplementation?${encodeURIComponent(JSON.stringify([document.uri, position.line]))}`;
		const markdown = new vscode.MarkdownString();
		markdown.isTrusted = true;

		if (lineType === 'interface') {
			// 接口或接口方法 - 显示跳转到实现
			markdown.appendMarkdown(`**接口**: ${methodName}\n\n[➡️ 跳转到实现](${commandUri})`);
		} else if (lineType === 'implementation') {
			// 实现方法或结构体 - 显示跳转到接口定义
			markdown.appendMarkdown(`**实现**: ${methodName}\n\n[⬆️ 跳转到接口定义](${commandUri})`);
		} else {
			// 默认情况
			markdown.appendMarkdown(`[➡️ 跳转到 ${methodName} 的实现](${commandUri})`);
		}

		return new vscode.Hover(markdown);
	}

	// 跳转到接口定义
	private async jumpToInterface(uri: vscode.Uri, line: number) {
		try {
			console.log(`准备跳转到接口: 行 ${line}`);
			const document = await vscode.workspace.openTextDocument(uri);
			const editor = await vscode.window.showTextDocument(document);

			// 获取方法名
			const docKey = document.uri.toString();
			const methodMap = this.cacheManager.getMethodMap(docKey);
			const methodName = methodMap?.get(line);
			console.log(`实现方法名: ${methodName}`);

			if (!methodName) {
				console.error('未找到方法名');
				vscode.window.showErrorMessage('未找到方法名');
				return;
			}

			// 获取行文本找到方法名的位置
			const lineText = document.lineAt(line).text;
			const methodNameIndex = lineText.indexOf(methodName);

			if (methodNameIndex < 0) {
				console.error('在行中未找到方法名');
				vscode.window.showErrorMessage('在行中未找到方法名');
				return;
			}

			// 定位光标到方法名上
			const position = new vscode.Position(line, methodNameIndex + Math.floor(methodName.length / 2));
			editor.selection = new vscode.Selection(position, position);
			editor.revealRange(new vscode.Range(position, position));

			// 使用VS Code内置命令
			await vscode.commands.executeCommand('editor.action.goToTypeDefinition');
		} catch (error) {
			console.error('跳转失败:', error);
			vscode.window.showErrorMessage('无法跳转到接口方法');
		}
	}

	// 跳转到实现
	private async jumpToImplementation(uri: vscode.Uri, line: number) {
		try {
			console.log(`准备跳转到实现: 行 ${line}`);
			const document = await vscode.workspace.openTextDocument(uri);
			const editor = await vscode.window.showTextDocument(document);

			// 获取方法名
			const docKey = document.uri.toString();
			const methodMap = this.cacheManager.getMethodMap(docKey);
			const methodName = methodMap?.get(line);
			console.log(`接口方法名: ${methodName}`);

			if (!methodName) {
				console.error('未找到方法名');
				vscode.window.showErrorMessage('未找到方法名');
				return;
			}

			// 获取行文本找到方法名的位置
			const lineText = document.lineAt(line).text;
			const methodNameIndex = lineText.indexOf(methodName);

			if (methodNameIndex < 0) {
				console.error('在行中未找到方法名');
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
			console.error('跳转失败:', error);
			vscode.window.showErrorMessage('无法跳转到实现');
		}
	}

	// 更新装饰的节流函数
	private throttleUpdateDecorations(editor: vscode.TextEditor) {
		// 取消先前的更新计时器
		if (this.updateThrottleTimer) {
			clearTimeout(this.updateThrottleTimer);
		}

		// 设置新的延迟更新，采用更短的延迟时间
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

		const document = editor.document;
		const docKey = document.uri.toString();

		try {
			// 获取装饰信息
			const {
				interfaceDecorations: interfaceInfos,
				implementationDecorations: implementationInfos,
				lineToMethodMap,
				lineTypeMap
			} = await this.parserManager.getAllDecorations(document);

			// 更新缓存
			const docDecoratedLines = new Set<number>();
			for (const line of lineToMethodMap.keys()) {
				docDecoratedLines.add(line);
			}

			this.cacheManager.updateMethodMap(docKey, lineToMethodMap);
			this.cacheManager.updateLineTypeMap(docKey, lineTypeMap);
			this.cacheManager.updateDecoratedLines(docKey, docDecoratedLines);

			// 触发 CodeLens 更新
			if (this.codeLensProvider) {
				this.codeLensProvider.refresh();
			}

			// 检查是否需要显示 Gutter Icons
			const config = vscode.workspace.getConfiguration('ijump');
			const displayMode = config.get<string>('displayMode', 'both');

			if (displayMode === 'codelens') {
				// 如果仅显示 CodeLens，清空 Gutter Icons
				this.decorationManager.applyDecorations(editor, [], []);
				return;
			}

			// 生成 Gutter Icons 装饰 options
			const interfaceDecorations: vscode.DecorationOptions[] = [];
			const implementationDecorations: vscode.DecorationOptions[] = [];

			// 处理接口装饰
			for (const info of interfaceInfos) {
				const commandUri = vscode.Uri.parse(
					`command:ijump.jumpToImplementation?${encodeURIComponent(JSON.stringify([document.uri, info.line]))}`
				);
				const hoverMessage = new vscode.MarkdownString(`**接口**: ${info.name}\n\n[$(symbol-interface) 跳转到实现](${commandUri})`);
				hoverMessage.isTrusted = true;

				// 计算范围 - 尝试定位到方法名末尾以支持 Inline 模式
				let range = new vscode.Range(info.line, 0, info.line, 0);
				try {
					const lineText = document.lineAt(info.line).text;
					const nameIndex = lineText.indexOf(info.name);
					if (nameIndex >= 0) {
						const endPos = nameIndex + info.name.length;
						range = new vscode.Range(info.line, endPos, info.line, endPos);
					}
				} catch (e) {
					// 忽略可能的行号错误
				}

				interfaceDecorations.push({
					range,
					hoverMessage
				});
			}

			// 处理实现装饰
			for (const info of implementationInfos) {
				const commandUri = vscode.Uri.parse(
					`command:ijump.jumpToInterface?${encodeURIComponent(JSON.stringify([document.uri, info.line]))}`
				);
				const hoverMessage = new vscode.MarkdownString(`**实现**: ${info.name}\n\n[$(symbol-class) 跳转到接口定义](${commandUri})`);
				hoverMessage.isTrusted = true;

				// 计算范围 - 尝试定位到方法名末尾以支持 Inline 模式
				let range = new vscode.Range(info.line, 0, info.line, 0);
				try {
					const lineText = document.lineAt(info.line).text;
					const nameIndex = lineText.indexOf(info.name);
					if (nameIndex >= 0) {
						const endPos = nameIndex + info.name.length;
						range = new vscode.Range(info.line, endPos, info.line, endPos);
					}
				} catch (e) {
					// 忽略
				}

				implementationDecorations.push({
					range,
					hoverMessage
				});
			}

			// 应用装饰
			this.decorationManager.applyDecorations(editor, interfaceDecorations, implementationDecorations);

		} catch (error) {
			console.error('[IJump] 更新装饰失败:', error);
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
				this.parserManager.clearCache();
				vscode.window.showInformationMessage('IJump: 已清除所有缓存');

				// 如果当前有活动编辑器，更新装饰
				if (vscode.window.activeTextEditor) {
					this.throttleUpdateDecorations(vscode.window.activeTextEditor);
				}
			})
		);

		// 切换解析模式命令
		this.context.subscriptions.push(
			vscode.commands.registerCommand('ijump.switchMode', async () => {
				const modes = [
					{ label: 'auto', description: '自动选择（优先 parser，不可用时回退到 gopls）' },
					{ label: 'parser', description: '使用自定义 Go 解析器' },
					{ label: 'gopls', description: '使用 gopls 语言服务器（需要 Go 扩展）' }
				];

				const currentMode = this.parserManager.getCurrentMode();
				const selected = await vscode.window.showQuickPick(modes, {
					placeHolder: `选择解析模式（当前: ${currentMode}）`
				});

				if (selected) {
					await this.parserManager.switchMode(selected.label as 'auto' | 'parser' | 'gopls');
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
						// 立即更新，不使用节流
						this.updateDecorations(editor);
						this.lastAnalyzedFile = editor.document.uri.fsPath;
					}
				}
			})
		);

		// 监听文档保存 - 只在保存Go文件时更新，而不是每次编辑
		this.context.subscriptions.push(
			vscode.workspace.onDidSaveTextDocument(document => {
				const editor = vscode.window.activeTextEditor;
				if (editor && document.languageId === 'go' && document === editor.document) {
					// 清除保存文件所在包的缓存
					this.parser.clearCache(document.uri.fsPath);
					// 立即更新，不使用节流
					this.updateDecorations(editor);
				}
			})
		);

		// 添加悬停提示
		this.context.subscriptions.push(
			vscode.languages.registerHoverProvider('go', {
				provideHover: (document, position, token) => this.provideHover(document, position, token)
			})
		);

		// 监听配置变化
		this.context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(e => {
				if (e.affectsConfiguration('ijump')) {
					this.decorationManager.configure();
					// 如果有活动编辑器，刷新装饰
					if (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.languageId === 'go') {
						this.throttleUpdateDecorations(vscode.window.activeTextEditor);
					}
					// 刷新 CodeLens
					this.codeLensProvider.refresh();
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
				// 新文件创建时清除所在包的缓存
				this.parser.clearCache(uri.fsPath);

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
				// 文件删除时清除所在包的缓存
				this.parser.clearCache(uri.fsPath);

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
	console.log('扩展 "ijump" 已激活!');

	// 创建并初始化扩展
	const extension = new IJumpExtension(context);
	extension.initialize();
}

// 停用扩展
export function deactivate() { }

