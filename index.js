#!/usr/bin/env node

const { spawn, exec } = require( 'child_process' );
const path = require( 'path' );
const fs = require( 'fs' );
const readline = require( 'readline' );
const os = require( 'os' );
const { Transform } = require( 'stream' );

// 配置文件路径
const CONFIG_FILE = path.join( os.homedir(), '.project-starter.json' );

// 内存优化配置
const MEMORY_CONFIG = {
    MAX_BUFFER_SIZE: 10 * 1024 * 1024, // 10MB 缓冲区限制
    LINE_RETENTION_COUNT: 1000, // 保留最近1000行日志
    LOG_RETENTION_WINDOW_MS: 15 * 60 * 1000, // 日志时间窗口：15分钟
    LOG_CLEANUP_INTERVAL_MS: 30 * 1000, // 清理周期：30秒
    STARTUP_DELAY_MS: 1000, // 进程启动间隔1秒
    MEMORY_CHECK_INTERVAL_MS: 30000 // 30秒检查一次内存
};

// 日志配置
const LOG_CONFIG = {
    MODES: {
        CONSOLE: 'console',  // 终端输出（默认）
        FILE: 'file',        // 文件输出（最低内存）
        BOTH: 'both'         // 同时输出
    },
    DEFAULT_MODE: 'console',
    DEFAULT_DIR: path.join(process.cwd(), 'logs'),
    DEFAULT_RETENTION_DAYS: 7,
    FILE_MAX_SIZE: 50 * 1024 * 1024, // 50MB 单文件
    HIGH_WATER_MARK: 16 * 1024 // 16KB 写入缓冲
};

// 默认配置
const defaultConfig = {
  projects: {},
  platforms: {},
  globalPreCommands: [] // 添加全局前置命令配置
};

// 获取格式化的日期字符串
function getDateString() {
    const now = new Date();
    return now.toISOString().split('T')[0].replace(/-/g, '');
}

// 创建日志目录
function ensureLogDirectory(platformName, logDir = LOG_CONFIG.DEFAULT_DIR) {
    const platformLogDir = path.join(logDir, platformName);
    if (!fs.existsSync(platformLogDir)) {
        fs.mkdirSync(platformLogDir, { recursive: true });
    }
    return platformLogDir;
}

// 获取日志文件路径
function getLogFilePath(projectName, platformName, logDir = LOG_CONFIG.DEFAULT_DIR) {
    const dateStr = getDateString();
    const platformLogDir = ensureLogDirectory(platformName, logDir);
    return path.join(platformLogDir, `${projectName}-${dateStr}.log`);
}

// 获取子进程的内存使用情况（跨平台）
function getChildProcessMemory(pid) {
    return new Promise((resolve) => {
        // macOS 和 Linux
        if (os.platform() !== 'win32') {
            exec(`ps -o rss= -p ${pid}`, (error, stdout) => {
                if (error) {
                    resolve(0);
                    return;
                }
                // ps 返回的是 KB，转换为字节
                const rssKB = parseInt(stdout.trim(), 10);
                resolve(rssKB * 1024);
            });
        } else {
            // Windows
            exec(`wmic process where processid=${pid} get WorkingSetSize`, (error, stdout) => {
                if (error) {
                    resolve(0);
                    return;
                }
                const lines = stdout.trim().split('\n');
                if (lines.length < 2) {
                    resolve(0);
                    return;
                }
                const bytes = parseInt(lines[1].trim(), 10);
                resolve(bytes || 0);
            });
        }
    });
}

// 获取所有子进程的总内存
async function getTotalChildProcessesMemory(processes) {
    let totalMemory = 0;

    for (const proc of processes) {
        if (proc && proc.pid) {
            const memory = await getChildProcessMemory(proc.pid);
            totalMemory += memory;
        }
    }

    return totalMemory;
}

// 清理旧日志文件
function cleanOldLogs(platformName, logDir = LOG_CONFIG.DEFAULT_DIR, retentionDays = LOG_CONFIG.DEFAULT_RETENTION_DAYS) {
    const platformLogDir = path.join(logDir, platformName);

    if (!fs.existsSync(platformLogDir)) {
        return;
    }

    const now = Date.now();
    const retentionMs = retentionDays * 24 * 60 * 60 * 1000;

    try {
        const files = fs.readdirSync(platformLogDir);

        files.forEach(file => {
            const filePath = path.join(platformLogDir, file);
            const stats = fs.statSync(filePath);

            // 删除超过保留天数的日志文件
            if (now - stats.mtimeMs > retentionMs) {
                fs.unlinkSync(filePath);
                console.log(`\x1b[90m[日志清理] 删除旧日志: ${file}\x1b[0m`);
            }
        });
    } catch (error) {
        console.error(`\x1b[31m[错误] 清理日志失败: ${error.message}\x1b[0m`);
    }
}

// 流量控制的Transform Stream，限制内存占用并支持时间窗口清理
class ThrottledOutputStream extends Transform {
    constructor(options = {}) {
        super(options);
        this.lineCount = 0;
        this.maxLines = options.maxLines || MEMORY_CONFIG.LINE_RETENTION_COUNT;

        // 时间窗口配置（毫秒），默认15分钟，非正值回退到默认
        const windowMs = options.retentionWindowMs ?? MEMORY_CONFIG.LOG_RETENTION_WINDOW_MS;
        this.retentionWindowMs = windowMs > 0 ? windowMs : MEMORY_CONFIG.LOG_RETENTION_WINDOW_MS;

        // 清理周期配置（毫秒），默认30秒，非正值回退到默认
        const cleanupMs = options.cleanupIntervalMs ?? MEMORY_CONFIG.LOG_CLEANUP_INTERVAL_MS;
        this.cleanupIntervalMs = cleanupMs > 0 ? cleanupMs : MEMORY_CONFIG.LOG_CLEANUP_INTERVAL_MS;

        // 缓冲区存储 {timestamp, line} 对象
        this.buffer = [];

        // 启动定时清理任务，使用 unref() 避免阻塞进程退出
        this.cleanupTimer = setInterval(() => {
            this.pruneExpired(Date.now());
        }, this.cleanupIntervalMs);
        this.cleanupTimer.unref();
    }

    // 添加日志条目（带时间戳）
    pushEntry(line, timestamp) {
        this.buffer.push({ timestamp, line });
        this.lineCount++;

        // 超过行数限制时，丢弃最旧的数据
        if (this.lineCount > this.maxLines) {
            this.buffer.shift();
            this.lineCount--;
        }
    }

    // 清理过期日志（超出时间窗口）
    pruneExpired(now) {
        const cutoff = now - this.retentionWindowMs;

        // 从头部移除所有过期条目
        while (this.buffer.length > 0 && this.buffer[0].timestamp < cutoff) {
            this.buffer.shift();
            this.lineCount--;
        }
    }

    _transform(chunk, encoding, callback) {
        const lines = chunk.toString().split('\n');
        const now = Date.now();

        for (const line of lines) {
            if (line.trim()) {
                this.pushEntry(line, now);
            }
        }

        // 主动触发过期清理
        this.pruneExpired(now);

        // 直接输出，不缓存
        this.push(chunk);
        callback();
    }

    // 清理定时器
    clearCleanupTimer() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }

    _flush(callback) {
        // 清理定时器和缓冲区
        this.clearCleanupTimer();
        this.buffer = [];
        this.lineCount = 0;
        callback();
    }

    _destroy(error, callback) {
        // 确保定时器被清理
        this.clearCleanupTimer();
        this.buffer = [];
        this.lineCount = 0;
        super._destroy(error, callback);
    }
}

// 加载或创建配置文件
function loadConfig() {
    try {
        if ( fs.existsSync( CONFIG_FILE ) ) {
            const configData = fs.readFileSync( CONFIG_FILE, 'utf8' );
            return JSON.parse( configData );
        } else {
            // 创建默认配置文件
            fs.writeFileSync( CONFIG_FILE, JSON.stringify( defaultConfig, null, 2 ), 'utf8' );
            console.log( `\x1b[33m[提示] 已创建默认配置文件: ${CONFIG_FILE}\x1b[0m` );
            return defaultConfig;
        }
    } catch ( error ) {
        console.error( `\x1b[31m[错误] 加载配置文件失败: ${error.message}\x1b[0m` );
        return defaultConfig;
    }
}

// 保存配置文件
function saveConfig( config ) {
    try {
        fs.writeFileSync( CONFIG_FILE, JSON.stringify( config, null, 2 ), 'utf8' );
        console.log( `\x1b[32m[成功] 配置已保存到: ${CONFIG_FILE}\x1b[0m` );
    } catch ( error ) {
        console.error( `\x1b[31m[错误] 保存配置文件失败: ${error.message}\x1b[0m` );
    }
}

// 启动单个项目
async function startProject(projectName, config, options = {}) {
    const {
        logMode = LOG_CONFIG.DEFAULT_MODE,
        logDir = LOG_CONFIG.DEFAULT_DIR,
        platformName = 'default',
        logBufferWindowMs = null // 日志缓冲区时间窗口（毫秒）
    } = options;
    const projectConfig = config.projects[projectName];

    if (!projectConfig) {
        console.log(`\x1b[31m[错误] 未找到项目配置: ${projectName}\x1b[0m`);
        return null;
    }

    const projectPath = projectConfig.path;

    // 检查项目路径是否存在
    if (!fs.existsSync(projectPath)) {
        console.log(`\x1b[31m[错误] 项目路径不存在: ${projectPath}\x1b[0m`);
        return null;
    }

    console.log(`\x1b[36m[${projectName}] 开始启动流程\x1b[0m`);

    // 执行前置命令的通用函数
    async function executeCommand(command, type) {
        console.log(`\x1b[36m[${type}] ${command}\x1b[0m`);

        // 检查命令是否需要在后台运行（以 & 结尾）
        const isBackgroundCommand = command.trim().endsWith('&');
        const actualCommand = isBackgroundCommand ? command.trim().slice(0, -1).trim() : command;

        // 将命令拆分为主命令和参数
        const [cmd, ...args] = actualCommand.split(' ');

        try {
            // 设置超时时间（默认10秒）
            const TIMEOUT = 10000; // 10秒

            // 创建一个可以被超时的Promise
            const commandPromise = new Promise((resolve, reject) => {
                const result = spawn(cmd, args, {
                    cwd: projectPath,
                    stdio: 'inherit',
                    shell: true,
                    detached: isBackgroundCommand // 如果是后台命令，设置为分离模式
                });

                if (isBackgroundCommand) {
                    // 后台命令立即解析，不等待
                    result.unref(); // 允许父进程独立于子进程退出
                    console.log(`\x1b[36m[后台运行] ${command}\x1b[0m`);
                    resolve(0);
                    return;
                }

                result.on('close', code => {
                    if (code === 0) {
                        resolve(code);
                    } else {
                        console.log(`\x1b[31m[警告] ${type}退出码: ${code}\x1b[0m`);
                        resolve(code); // 即使失败也继续执行
                    }
                });

                result.on('error', err => {
                    console.error(`\x1b[31m[错误] ${type}失败: ${err.message}\x1b[0m`);
                    resolve(1); // 即使失败也继续执行
                });
            });

            // 创建一个超时Promise
            const timeoutPromise = new Promise(resolve => {
                setTimeout(() => {
                    console.log(`\x1b[33m[警告] ${type}执行超时，继续下一步\x1b[0m`);
                    resolve('timeout');
                }, TIMEOUT);
            });

            // 竞争Promise，哪个先完成就返回哪个
            const result = await Promise.race([commandPromise, timeoutPromise]);

            if (result === 'timeout') {
                console.log(`\x1b[33m[警告] 命令可能在后台运行: ${command}\x1b[0m`);
            }
        } catch (error) {
            console.error(`\x1b[31m[错误] 执行命令失败: ${error.message}\x1b[0m`);
        }
    }

    // 执行全局前置命令
    if (config.globalPreCommands && config.globalPreCommands.length > 0) {
        console.log(`\x1b[36m[${projectName}] 执行全局前置命令\x1b[0m`);

        for (const preCommand of config.globalPreCommands) {
            await executeCommand(preCommand, `${projectName} 全局前置命令`);
        }
    }

    // 执行项目特定前置命令
    if (projectConfig.preCommands && projectConfig.preCommands.length > 0) {
        console.log(`\x1b[36m[${projectName}] 执行项目特定前置命令\x1b[0m`);

        for (const preCommand of projectConfig.preCommands) {
            await executeCommand(preCommand, `${projectName} 项目前置命令`);
        }
    }

    const command = projectConfig.command;
    console.log(`\x1b[36m[${projectName}] 执行启动命令: ${command}\x1b[0m`);

    // 将命令拆分为主命令和参数
    const [cmd, ...args] = command.split(' ');

    // 根据日志模式决定 stdio 配置
    let stdioConfig = 'pipe'; // 默认使用 pipe

    // file 模式下使用 inherit 以获得最低内存占用
    if (logMode === LOG_CONFIG.MODES.FILE) {
        stdioConfig = 'inherit';
    }

    // 使用 spawn 启动项目
    const process = spawn(cmd, args, {
        cwd: projectPath,
        stdio: stdioConfig,
        shell: true
    });

    // 给进程着色输出 - 为每个项目分配固定颜色
    const colors = ['\x1b[32m', '\x1b[33m', '\x1b[34m', '\x1b[35m', '\x1b[36m', '\x1b[90m', '\x1b[94m', '\x1b[96m'];
    const colorIndex = Math.abs(projectName.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)) % colors.length;
    const color = colors[colorIndex];

    // 用于检测是否为编译信息的正则表达式
    const compilePatterns = [
        /webpack\.Progress/i,
        /building/i,
        /modules/i,
        /compiled/i,
        /compiling/i,
        /bundling/i,
        /chunk/i
    ];

    // 如果是 console 或 both 模式，处理输出
    if (logMode === LOG_CONFIG.MODES.CONSOLE || logMode === LOG_CONFIG.MODES.BOTH) {
        // 创建流量控制的Transform Stream，传入时间窗口配置
        const throttleOptions = logBufferWindowMs !== null ? { retentionWindowMs: logBufferWindowMs } : {};
        const stdoutThrottle = new ThrottledOutputStream(throttleOptions);
        const stderrThrottle = new ThrottledOutputStream(throttleOptions);

        // 使用pipe连接，避免在内存中累积所有数据
        process.stdout.pipe(stdoutThrottle).on('data', (data) => {
            const lines = data.toString().split('\n').filter(line => line.trim());
            lines.forEach(line => {
                console.log(`${color}[${projectName}] ${line}\x1b[0m`);
            });
        });

        process.stderr.pipe(stderrThrottle).on('data', (data) => {
            const lines = data.toString().split('\n').filter(line => line.trim());

            lines.forEach(output => {
                const isCompileInfo = compilePatterns.some(pattern => pattern.test(output));

                if (isCompileInfo) {
                    console.log(`${color}[${projectName}] ${output}\x1b[0m`);
                } else {
                    console.error(`\x1b[31m[${projectName} 错误] ${output}\x1b[0m`);
                }
            });
        });
    }

    // 如果是 file 或 both 模式，写入日志文件
    if (logMode === LOG_CONFIG.MODES.FILE || logMode === LOG_CONFIG.MODES.BOTH) {
        const logFilePath = getLogFilePath(projectName, platformName, logDir);

        // 创建日志文件写入流
        const logStream = fs.createWriteStream(logFilePath, {
            flags: 'a', // 追加模式
            encoding: 'utf8',
            highWaterMark: LOG_CONFIG.HIGH_WATER_MARK
        });

        // 记录启动时间和命令
        const timestamp = new Date().toISOString();
        logStream.write(`\n${'='.repeat(80)}\n`);
        logStream.write(`[${timestamp}] 项目启动: ${projectName}\n`);
        logStream.write(`命令: ${command}\n`);
        logStream.write(`路径: ${projectPath}\n`);
        logStream.write(`${'='.repeat(80)}\n\n`);

        // 将输出写入文件（仅在 both 模式下，file 模式使用 inherit）
        if (logMode === LOG_CONFIG.MODES.BOTH) {
            process.stdout.on('data', (data) => {
                logStream.write(`[STDOUT] ${data.toString()}`);
            });

            process.stderr.on('data', (data) => {
                logStream.write(`[STDERR] ${data.toString()}`);
            });
        }

        // 进程关闭时关闭日志流
        process.on('close', (code) => {
            const endTimestamp = new Date().toISOString();
            logStream.write(`\n[${endTimestamp}] 进程退出，退出码: ${code}\n`);
            logStream.end();
        });

        // 显示日志文件路径
        if (logMode === LOG_CONFIG.MODES.FILE) {
            console.log(`\x1b[36m[${projectName}] 📝 日志文件: ${logFilePath}\x1b[0m`);
            console.log(`\x1b[90m  查看实时日志: tail -f ${logFilePath}\x1b[0m`);
        }
    }

    process.on('close', (code) => {
        if (code !== 0) {
            console.log(`\x1b[31m[${projectName}] 进程退出，退出码 ${code}\x1b[0m`);
        } else {
            console.log(`\x1b[90m[${projectName}] 进程正常退出\x1b[0m`);
        }
    });

    // 添加启动成功的日志
    setTimeout(() => {
        console.log(`\x1b[32m[${projectName}] 项目进程已启动\x1b[0m`);
    }, 100);

    return process;
}

// 添加新项目配置
async function addProject(rl, config) {
    console.log('\n\x1b[1m添加新项目\x1b[0m');

    const name = await question(rl, '项目名称: ');
    const path = await question(rl, '项目路径: ');
    const command = await question(rl, '启动命令 (默认: npm run serve): ') || 'npm run serve';

    // 询问前置命令
    const hasPreCommands = await question(rl, '是否需要添加前置命令? (y/N): ');

    const preCommands = [];
    if (hasPreCommands.toLowerCase() === 'y') {
        console.log('请输入前置命令，每行一条，输入空行结束：');
        console.log('提示: 在命令末尾添加"&"表示该命令在后台运行，不等待其完成');

        let preCommand;
        do {
            preCommand = await question(rl, '> ');
            if (preCommand) {
                preCommands.push(preCommand);
            }
        } while (preCommand);
    }

    config.projects[name] = {
        path,
        command,
        preCommands: preCommands.length > 0 ? preCommands : undefined
    };

    // 询问是否添加到平台
    const addToPlatform = await question( rl, '是否添加到平台? (y/N): ' );
    if ( addToPlatform.toLowerCase() === 'y' ) {
        // 显示现有平台
        console.log( '\n现有平台:' );
        Object.keys( config.platforms ).forEach( platform => {
            console.log( `- ${platform} (${config.platforms[platform].join( ', ' )})` );
        } );

        const platform = await question( rl, '平台名称 (新平台或现有平台): ' );

        if ( !config.platforms[platform] ) {
            config.platforms[platform] = [];
        }

        if ( !config.platforms[platform].includes( name ) ) {
            config.platforms[platform].push( name );
        }
    }

    saveConfig( config );
    console.log( `\x1b[32m[成功] 已添加项目: ${name}\x1b[0m` );
}

// 管理平台配置
async function managePlatforms( rl, config ) {
    console.log( '\n\x1b[1m管理平台\x1b[0m' );
    console.log( '1. 查看所有平台' );
    console.log( '2. 添加新平台' );
    console.log( '3. 编辑现有平台' );
    console.log( '4. 删除平台' );
    console.log( '0. 返回主菜单' );

    const choice = await question( rl, '请选择操作: ' );

    switch ( choice ) {
        case '1':
            console.log( '\n现有平台:' );
            Object.keys( config.platforms ).forEach( platform => {
                console.log( `- ${platform} (${config.platforms[platform].join( ', ' )})` );
            } );
            break;

        case '2':
            const newPlatform = await question( rl, '新平台名称: ' );
            config.platforms[newPlatform] = [];

            // 显示所有项目
            console.log( '\n可用项目:' );
            Object.keys( config.projects ).forEach( project => {
                console.log( `- ${project}` );
            } );

            const projects = await question( rl, '添加项目 (用逗号分隔): ' );
            config.platforms[newPlatform] = projects.split( ',' ).map( p => p.trim() ).filter( p => config.projects[p] );

            saveConfig( config );
            console.log( `\x1b[32m[成功] 已添加平台: ${newPlatform}\x1b[0m` );
            break;

        case '3':
            console.log( '\n现有平台:' );
            Object.keys( config.platforms ).forEach( platform => {
                console.log( `- ${platform}` );
            } );

            const editPlatform = await question( rl, '要编辑的平台名称: ' );
            if ( !config.platforms[editPlatform] ) {
                console.log( `\x1b[31m[错误] 平台不存在: ${editPlatform}\x1b[0m` );
                break;
            }

            console.log( `\n当前项目: ${config.platforms[editPlatform].join( ', ' )}` );
            console.log( '\n可用项目:' );
            Object.keys( config.projects ).forEach( project => {
                console.log( `- ${project}` );
            } );

            const newProjects = await question( rl, '新的项目列表 (用逗号分隔): ' );
            config.platforms[editPlatform] = newProjects.split( ',' ).map( p => p.trim() ).filter( p => config.projects[p] );

            saveConfig( config );
            console.log( `\x1b[32m[成功] 已更新平台: ${editPlatform}\x1b[0m` );
            break;

        case '4':
            console.log( '\n现有平台:' );
            Object.keys( config.platforms ).forEach( platform => {
                console.log( `- ${platform}` );
            } );

            const deletePlatform = await question( rl, '要删除的平台名称: ' );
            if ( config.platforms[deletePlatform] ) {
                delete config.platforms[deletePlatform];
                saveConfig( config );
                console.log( `\x1b[32m[成功] 已删除平台: ${deletePlatform}\x1b[0m` );
            } else {
                console.log( `\x1b[31m[错误] 平台不存在: ${deletePlatform}\x1b[0m` );
            }
            break;
    }
}

// 辅助函数：提问
function question( rl, query ) {
    return new Promise( resolve => {
        rl.question( query, answer => {
            resolve( answer.trim() );
        } );
    } );
}

// 解析命令行参数
function parseArgs(args) {
    const parsed = {
        command: null,
        logMode: LOG_CONFIG.DEFAULT_MODE,
        logDir: LOG_CONFIG.DEFAULT_DIR,
        logRetentionDays: LOG_CONFIG.DEFAULT_RETENTION_DAYS,
        logBufferWindowMs: null // 日志缓冲区时间窗口（毫秒）
    };

    // 提取非选项参数（平台/项目名称）
    const nonOptionArgs = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg.startsWith('--log-mode=')) {
            parsed.logMode = arg.split('=')[1];
        } else if (arg.startsWith('--log-dir=')) {
            parsed.logDir = arg.split('=')[1];
        } else if (arg.startsWith('--log-retention=')) {
            parsed.logRetentionDays = parseInt(arg.split('=')[1], 10);
        } else if (arg.startsWith('--log-buffer-window-min=')) {
            // 支持以分钟为单位设置时间窗口
            const minutes = parseInt(arg.split('=')[1], 10);
            parsed.logBufferWindowMs = minutes * 60 * 1000;
        } else if (arg.startsWith('--log-buffer-window-ms=')) {
            // 支持以毫秒为单位设置时间窗口
            parsed.logBufferWindowMs = parseInt(arg.split('=')[1], 10);
        } else {
            nonOptionArgs.push(arg);
        }
    }

    parsed.command = nonOptionArgs[0];
    return parsed;
}

// 主函数
async function main() {
    const config = loadConfig();

    // 解析命令行参数
    const rawArgs = process.argv.slice( 2 );
    const args = parseArgs(rawArgs);
    const command = args.command;

    // 创建readline接口
    const rl = readline.createInterface( {
        input: process.stdin,
        output: process.stdout
    } );

    // 处理命令
    if ( command === 'config' ) {
        // 进入配置模式
        await configMode( rl, config );
    } else if ( command === 'list' ) {
        // 列出所有平台和项目
        console.log( '\n\x1b[1m可用平台:\x1b[0m' );
        Object.keys( config.platforms ).forEach( platform => {
            console.log( `- ${platform} (${config.platforms[platform].join( ', ' )})` );
        } );

        console.log( '\n\x1b[1m可用项目:\x1b[0m' );
        Object.keys( config.projects ).forEach( project => {
            console.log( `- ${project} (${config.projects[project].path})` );
        } );
        rl.close();
    } else {
        // 启动模式
        let platformName = command;

        if ( !platformName ) {
            // 显示所有可用平台
            console.log( '\n\x1b[1m可用平台:\x1b[0m' );
            Object.keys( config.platforms ).forEach( platform => {
                console.log( `- ${platform} (${config.platforms[platform].join( ', ' )})` );
            } );

            platformName = await question( rl, '\n请选择要启动的平台: ' );
        }

        // 如果输入的是项目名而不是平台名
        let projectsToStart = [];
        if ( config.platforms[platformName] ) {
            projectsToStart = config.platforms[platformName];
        } else if ( config.projects[platformName] ) {
            projectsToStart = [platformName];
        } else {
            console.log( `\x1b[31m[错误] 未知平台或项目: ${platformName}\x1b[0m` );
            console.log( '可用平台: ' + Object.keys( config.platforms ).join( ', ' ) );
            console.log( '可用项目: ' + Object.keys( config.projects ).join( ', ' ) );
            rl.close();
            return;
        }

        rl.close();

        if ( projectsToStart.length === 0 ) {
            console.log( `\x1b[33m[警告] 平台 ${platformName} 没有配置任何项目\x1b[0m` );
            return;
        }

        // 显示日志模式信息
        const logModeNames = {
            [LOG_CONFIG.MODES.CONSOLE]: '终端输出（默认）',
            [LOG_CONFIG.MODES.FILE]: '文件输出（最低内存）',
            [LOG_CONFIG.MODES.BOTH]: '同时输出'
        };

        console.log( `\n\x1b[1m正在并发启动平台 ${platformName} 的项目: ${projectsToStart.join( ', ' )}\x1b[0m` );
        console.log( `\x1b[36m📝 日志模式: ${logModeNames[args.logMode] || args.logMode}\x1b[0m` );

        if (args.logMode !== LOG_CONFIG.MODES.CONSOLE) {
            console.log( `\x1b[36m📁 日志目录: ${args.logDir}\x1b[0m` );
        }

        console.log('');

        // 清理旧日志
        if (args.logMode !== LOG_CONFIG.MODES.CONSOLE) {
            cleanOldLogs(platformName, args.logDir, args.logRetentionDays);
        }

        // 并发启动所有项目
        const processes = [];

        // 创建所有项目的启动Promise
        const startPromises = projectsToStart.map(async (project, index) => {
            // 为每个项目添加延迟，避免同时启动导致的资源竞争和内存峰值
            await new Promise(resolve => setTimeout(resolve, index * MEMORY_CONFIG.STARTUP_DELAY_MS));

            console.log(`\x1b[36m[并发启动] 开始启动项目: ${project}\x1b[0m`);
            const proc = await startProject(project, config, {
                logMode: args.logMode,
                logDir: args.logDir,
                platformName: platformName,
                logBufferWindowMs: args.logBufferWindowMs || config.logBufferWindowMs || null
            });

            if (proc) {
                console.log(`\x1b[32m[并发启动] 项目 ${project} 启动成功\x1b[0m`);
                return { project, process: proc };
            } else {
                console.log(`\x1b[31m[并发启动] 项目 ${project} 启动失败\x1b[0m`);
                return null;
            }
        });

        // 等待所有项目启动完成
        console.log(`\x1b[36m[并发启动] 等待所有项目启动完成...\x1b[0m`);
        const results = await Promise.allSettled(startPromises);

        // 收集成功启动的进程
        results.forEach((result, index) => {
            if (result.status === 'fulfilled' && result.value) {
                processes.push(result.value.process);
            } else if (result.status === 'rejected') {
                console.error(`\x1b[31m[并发启动] 项目 ${projectsToStart[index]} 启动异常: ${result.reason}\x1b[0m`);
            }
        });

        if ( processes.length === 0 ) {
            console.log( '\x1b[33m[警告] 没有启动任何项目\x1b[0m' );
            return;
        }

        console.log( `\n\x1b[32m✅ 并发启动完成！成功启动 ${processes.length} 个项目\x1b[0m` );
        console.log( `\x1b[36m📊 启动统计: ${results.filter(r => r.status === 'fulfilled' && r.value).length}/${projectsToStart.length} 个项目启动成功\x1b[0m` );
        console.log( '\x1b[33m💡 按 Ctrl+C 可以关闭所有项目\x1b[0m' );

        // 启动内存监控（增强版：包含子进程内存）
        const memoryMonitor = setInterval(async () => {
            // 父进程内存
            const memUsage = process.memoryUsage();
            const parentRss = memUsage.rss;
            const heapUsed = memUsage.heapUsed;
            const heapTotal = memUsage.heapTotal;

            // 子进程内存
            const childMemory = await getTotalChildProcessesMemory(processes);

            // 总内存 = 父进程 + 所有子进程
            const totalMemory = parentRss + childMemory;

            // 转换为 MB
            const parentRssMB = (parentRss / 1024 / 1024).toFixed(2);
            const childMemoryMB = (childMemory / 1024 / 1024).toFixed(2);
            const totalMemoryMB = (totalMemory / 1024 / 1024).toFixed(2);
            const heapUsedMB = (heapUsed / 1024 / 1024).toFixed(2);
            const heapTotalMB = (heapTotal / 1024 / 1024).toFixed(2);
            const heapPercent = ((heapUsed / heapTotal) * 100).toFixed(1);

            // 根据总内存使用率选择颜色
            let statusColor = '\x1b[32m'; // 绿色 - 正常
            let statusIcon = '✓';

            // 使用总内存作为判断标准（50MB为警告阈值，100MB为危险阈值）
            const totalThresholdWarning = 50 * 1024 * 1024; // 50MB
            const totalThresholdDanger = 100 * 1024 * 1024; // 100MB

            if (totalMemory > totalThresholdWarning) {
                statusColor = '\x1b[33m'; // 黄色 - 警告
                statusIcon = '⚠';
            }

            if (totalMemory > totalThresholdDanger) {
                statusColor = '\x1b[31m'; // 红色 - 危险
                statusIcon = '✖';
            }

            // 更醒目的内存监控输出
            console.log(`\n${statusColor}╭──────────────── 内存监控 ────────────────╮\x1b[0m`);
            console.log(`${statusColor}│ ${statusIcon} 总内存: ${totalMemoryMB.padStart(8)}MB                │\x1b[0m`);
            console.log(`${statusColor}│   ├─ 父进程: ${parentRssMB.padStart(8)}MB                │\x1b[0m`);
            console.log(`${statusColor}│   └─ 子进程: ${childMemoryMB.padStart(8)}MB (${processes.length}个项目)    │\x1b[0m`);
            console.log(`${statusColor}│                                          │\x1b[0m`);
            console.log(`${statusColor}│ ${statusIcon} Heap:   ${heapUsedMB.padStart(8)}MB / ${heapTotalMB}MB (${heapPercent}%) │\x1b[0m`);

            // 如果内存超过阈值，显示警告信息
            if (totalMemory > totalThresholdDanger) {
                console.log(`${statusColor}│                                          │\x1b[0m`);
                console.log(`${statusColor}│ ⚠️  总内存使用量过高！建议操作：      │\x1b[0m`);
                console.log(`${statusColor}│   1. 使用 --log-mode=file 降低内存    │\x1b[0m`);
                console.log(`${statusColor}│   2. 减少同时启动的项目数量           │\x1b[0m`);
                console.log(`${statusColor}│   3. 重启释放内存                     │\x1b[0m`);
            } else if (totalMemory > totalThresholdWarning) {
                console.log(`${statusColor}│ ℹ️  总内存使用率较高，请注意监控      │\x1b[0m`);
            }

            console.log(`${statusColor}╰──────────────────────────────────────────╯\x1b[0m\n`);
        }, MEMORY_CONFIG.MEMORY_CHECK_INTERVAL_MS);

        // 显示启动失败的项目
        const failedProjects = results
            .map((result, index) => ({ result, project: projectsToStart[index] }))
            .filter(item => item.result.status === 'rejected' || !item.result.value)
            .map(item => item.project);

        if (failedProjects.length > 0) {
            console.log( `\x1b[31m❌ 启动失败的项目: ${failedProjects.join(', ')}\x1b[0m` );
        }

        // 处理终止信号
        process.on( 'SIGINT', () => {
            console.log( '\n\x1b[1m正在关闭所有项目...\x1b[0m' );

            // 清除内存监控定时器
            clearInterval(memoryMonitor);

            // 终止所有子进程
            processes.forEach( proc => {
                try {
                    proc.kill();
                } catch ( e ) {
                    // 忽略错误
                }
            } );
            process.exit( 0 );
        } );
    }
}

// 配置模式
async function configMode(rl, config) {
    console.log('\n\x1b[1m配置模式\x1b[0m');
    console.log('1. 添加新项目');
    console.log('2. 编辑现有项目');
    console.log('3. 管理平台');
    console.log('4. 设置全局前置命令'); // 新增选项
    console.log('0. 退出');

    const choice = await question(rl, '请选择操作: ');

    switch (choice) {
        case '1':
            await addProject(rl, config);
            await configMode(rl, config);
            break;
        case '2':
            await editProject(rl, config);
            await configMode(rl, config);
            break;
        case '3':
            await managePlatforms(rl, config);
            await configMode(rl, config);
            break;
        case '4':
            await configGlobalPreCommands(rl, config);
            await configMode(rl, config);
            break;
        case '0':
            rl.close();
            break;
        default:
            console.log('\x1b[31m[错误] 无效选择\x1b[0m');
            await configMode(rl, config);
    }
}

// 配置全局前置命令
async function configGlobalPreCommands(rl, config) {
    console.log('\n\x1b[1m配置全局前置命令\x1b[0m');
    console.log('这些命令将在启动每个项目前执行');
    console.log('提示: 在命令末尾添加"&"表示该命令在后台运行，不等待其完成');

    // 显示当前全局前置命令
    if (config.globalPreCommands && config.globalPreCommands.length > 0) {
        console.log('\n当前全局前置命令:');
        config.globalPreCommands.forEach((cmd, i) => console.log(`${i+1}. ${cmd}`));
    } else {
        console.log('\n当前没有全局前置命令');
    }

    console.log('\n请输入新的全局前置命令，每行一条，输入空行结束：');

    const globalPreCommands = [];
    let preCommand;
    do {
        preCommand = await question(rl, '> ');
        if (preCommand) {
            globalPreCommands.push(preCommand);
        }
    } while (preCommand);

    config.globalPreCommands = globalPreCommands;
    saveConfig(config);
    console.log(`\x1b[32m[成功] 已更新全局前置命令\x1b[0m`);
}

// 编辑项目
async function editProject(rl, config) {
    console.log('\n\x1b[1m编辑项目\x1b[0m');

    // 显示现有项目
    console.log('\n现有项目:');
    Object.keys(config.projects).forEach(project => {
        console.log(`- ${project}`);
    });

    const projectName = await question(rl, '请选择要编辑的项目: ');

    if (!config.projects[projectName]) {
        console.log(`\x1b[31m[错误] 项目不存在: ${projectName}\x1b[0m`);
        return;
    }

    const projectConfig = config.projects[projectName];
    console.log(`\n当前配置:`);
    console.log(`- 路径: ${projectConfig.path}`);
    console.log(`- 命令: ${projectConfig.command}`);
    console.log(`- 前置命令: ${projectConfig.preCommands ? projectConfig.preCommands.join(', ') : '无'}`);

    const editPath = await question(rl, `新路径 (当前: ${projectConfig.path}, 留空保持不变): `);
    const editCommand = await question(rl, `新启动命令 (当前: ${projectConfig.command}, 留空保持不变): `);

    const editPreCommands = await question(rl, '是否编辑前置命令? (y/N): ');

    let preCommands = projectConfig.preCommands || [];

    if (editPreCommands.toLowerCase() === 'y') {
        console.log('请输入前置命令，每行一条，输入空行结束：');
        if (preCommands.length > 0) {
            console.log('当前前置命令:');
            preCommands.forEach((cmd, i) => console.log(`${i+1}. ${cmd}`));
        }

        preCommands = [];
        let preCommand;
        do {
            preCommand = await question(rl, '> ');
            if (preCommand) {
                preCommands.push(preCommand);
            }
        } while (preCommand);
    }

    config.projects[projectName] = {
        path: editPath || projectConfig.path,
        command: editCommand || projectConfig.command,
        preCommands: preCommands.length > 0 ? preCommands : undefined
    };

    saveConfig(config);
    console.log(`\x1b[32m[成功] 已更新项目: ${projectName}\x1b[0m`);
}

main().catch( err => {
    console.error( '\x1b[31m[错误]', err, '\x1b[0m' );
    process.exit( 1 );
} );
