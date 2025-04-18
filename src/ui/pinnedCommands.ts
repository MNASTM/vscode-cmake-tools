import * as vscode from 'vscode';
import * as nls from 'vscode-nls';
import { getExtensionActiveCommands, getExtensionLocalizedStrings, onExtensionActiveCommandsChanged } from '@cmt/extension';
import * as logging from '@cmt/logging';
import { ConfigurationReader } from '@cmt/config';

nls.config({ messageFormat: nls.MessageFormat.bundle, bundleFormat: nls.BundleFormat.standalone })();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();
const log = logging.createLogger('pinnedCommands');
const defaultTaskCommands: string[] = ["workbench.action.tasks.configureTaskRunner", "workbench.action.tasks.runTask"];

interface PinnedCommandsQuickPickItem extends vscode.QuickPickItem {
    command: string;
}

/**
 * Represents a node in the tree view for a pinned command.
 * Extends the `vscode.TreeItem` class.
 */
class PinnedCommandNode extends vscode.TreeItem {
    /**
     * The name of the command associated with this node.
     */
    public commandName: string;

    /**
     * Indicates whether the command is visible in the UI.
     */
    public isVisible: boolean;

    /**
     * Creates an instance of `PinnedCommandNode`.
     * @param label - The label to display for this tree item.
     * @param command - The command to execute when this item is selected.
     * @param isVisible - A boolean indicating if the command is visible.
     */
    constructor(label: string, command: string, isVisible: boolean) {
        super(label);
        this.collapsibleState = vscode.TreeItemCollapsibleState.None;
        this.tooltip = label;
        this.commandName = command;
        this.isVisible = isVisible;
    }

    /**
     * Gets the tree item representation of this node.
     * @returns The tree item.
     */
    getTreeItem(): vscode.TreeItem {
        return this;
    }

    /**
     * Executes the command associated with this node.
     */
    async runThisCommand() {
        await vscode.commands.executeCommand(this.commandName);
    }
}

export class PinnedCommands {

    private treeDataProvider: PinnedCommandsTreeDataProvider;
    protected disposables: vscode.Disposable[] = [];

    constructor(configReader: ConfigurationReader, extensionContext: vscode.ExtensionContext) {
        this.treeDataProvider = new PinnedCommandsTreeDataProvider(configReader, extensionContext);
        this.disposables.push(...[
            // Commands for projectStatus items
            vscode.commands.registerCommand('cmake.pinnedCommands.add', async () => {
                const chosen = await this.showPinnableCommands();
                if (chosen !== null) {
                    await this.treeDataProvider.addCommand(chosen);
                }
            }),
            vscode.commands.registerCommand('cmake.pinnedCommands.remove', async (what: PinnedCommandNode) => {
                await this.treeDataProvider.removeCommand(what);
            }),
            vscode.commands.registerCommand('cmake.pinnedCommands.run', async (what: PinnedCommandNode) => {
                await this.treeDataProvider.runCommand(what);
            })
        ]);
    }

    /**
     * Show List of All Commands that can be pinned
     */
    async showPinnableCommands(): Promise<PinnedCommandsQuickPickItem | null> {
        const localization = getExtensionLocalizedStrings();
        const items = PinnedCommands.getPinnableCommands().map((x) => ({
            command: x,
            label: localization[`cmake-tools.command.${x}.title`]} as PinnedCommandsQuickPickItem));
        const chosenItem = await vscode.window.showQuickPick(items,
            { placeHolder: localize('add.pinned.cmake.command', 'Select a CMake command to pin') });
        if (!chosenItem) {
            log.debug(localize('user.cancelled.add.pinned.cmake.command', 'User cancelled selecting CMake Command to Pin'));
            return null;
        }
        return chosenItem;
    }

    refresh(): Promise<any> {
        return this.treeDataProvider.refresh();
    }

    dispose() {
        vscode.Disposable.from(...this.disposables).dispose();
        this.treeDataProvider.dispose();
    }

    static getPinnableCommands(): string[] {
        const commands = getExtensionActiveCommands();
        return commands.concat(defaultTaskCommands);
    }
}

class PinnedCommandsTreeDataProvider implements vscode.TreeDataProvider<PinnedCommandNode>, vscode.Disposable {
    private treeView: vscode.TreeView<PinnedCommandNode>;
    private _onDidChangeTreeData: vscode.EventEmitter<PinnedCommandNode | void> = new vscode.EventEmitter<PinnedCommandNode | void>();
    private pinnedCommands: PinnedCommandNode[] = [];
    private config: vscode.WorkspaceConfiguration | null;
    private pinnedCommandsKey: string = "cmake.pinnedCommands";
    private isInitialized = false;
    private readonly _settingsSub ;
    private extensionContext: vscode.ExtensionContext;

    constructor(configReader: ConfigurationReader, extensionContext: vscode.ExtensionContext) {
        this.treeView = vscode.window.createTreeView('cmake.pinnedCommands', { treeDataProvider: this });
        this._settingsSub = configReader.onChange('pinnedCommands', () => this.doConfigureSettingsChange());
        this.config = vscode.workspace.getConfiguration();
        this.extensionContext = extensionContext;
        onExtensionActiveCommandsChanged(this.doConfigureSettingsChange, this);
    }

    get onDidChangeTreeData(): vscode.Event<PinnedCommandNode | void | undefined> {
        return this._onDidChangeTreeData.event;
    }

    async initialize(): Promise<void> {
        this.config = vscode.workspace.getConfiguration();
        this.pinnedCommands = []; //reset to empty list.
        const localization = getExtensionLocalizedStrings();
        const activeCommands = new Set<string>(PinnedCommands.getPinnableCommands());

        const tryPushCommands = (commands: string[]) => {
            commands.forEach((x) => {
                const label = localization[`cmake-tools.command.${x}.title`];
                if (this.findNode(label) === -1) {
                    this.pinnedCommands.push(new PinnedCommandNode(label, x, activeCommands.has(x)));
                }
            });
        };

        // Pin the commands that are requested from the users settings.
        if (this.config.has(this.pinnedCommandsKey)) {
            const settingsPinnedCommands = this.config.get(this.pinnedCommandsKey) as string[];
            tryPushCommands(settingsPinnedCommands);
        }

        // Pin commands that were pinned in the last session.
        const lastSessionPinnedCommands = this.extensionContext.workspaceState.get(this.pinnedCommandsKey) as string[];
        if (lastSessionPinnedCommands) {
            tryPushCommands(lastSessionPinnedCommands);
        }

        this.isInitialized = true;
    }

    async doConfigureSettingsChange() {
        await this.initialize();
        await this.refresh();
    }

    async addCommand(chosen: PinnedCommandsQuickPickItem) {
        // first check if it is already in the list of pinned commands.
        if (this.findNode(chosen.label) === -1) {
            const node = new PinnedCommandNode(chosen.label, chosen.command, true);
            this.pinnedCommands.push(node);
            await this.refresh();
            await this.updateSettings();
        }
    }

    findNode(nodeLabel: string) {
        for (let i = 0; i < this.pinnedCommands.length; i++) {
            if (this.pinnedCommands[i].label === nodeLabel) {
                return i;
            }
        }
        return -1;
    }

    async removeCommand(node: PinnedCommandNode) {
        const index = this.findNode(node.label as string);
        if (index !== -1) {
            this.pinnedCommands.splice(index, 1);
            await this.refresh();
        }
        await this.updateSettings();
    }

    async runCommand(node: PinnedCommandNode) {
        await node.runThisCommand();
    }

    getTreeItem(node: PinnedCommandNode): vscode.TreeItem {
        return node.getTreeItem();
    }

    async updateSettings() {
        if (this.config) {
            const pinnedCommands: string[] = this.pinnedCommands.map(x => x.commandName);
            await this.extensionContext.workspaceState.update(this.pinnedCommandsKey, pinnedCommands);
        }
    }

    public async refresh() {
        this._onDidChangeTreeData.fire();
    }

    dispose(): void {
        this.treeView.dispose();
        this._settingsSub.dispose();
    }

    async getChildren(): Promise<PinnedCommandNode[]> {
        if (!this.isInitialized) {
            await this.initialize();
        }
        return this.pinnedCommands.filter(x => x.isVisible)!;
    }
}
