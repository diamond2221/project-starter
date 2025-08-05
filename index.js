#!/usr/bin/env node

const { spawn } = require( 'child_process' );
const path = require( 'path' );
const fs = require( 'fs' );
const readline = require( 'readline' );
const os = require( 'os' );

// 配置文件路径
const CONFIG_FILE = path.join( os.homedir(), '.project-starter.json' );

// 默认配置
const defaultConfig = {
  projects: {},
  platforms: {},
  globalPreCommands: [] // 添加全局前置命令配置
};

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
async function startProject(projectName, config) {
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

    // 使用 spawn 启动项目并保持输出流
    const process = spawn(cmd, args, {
        cwd: projectPath,
        stdio: 'pipe',
        shell: true
    });

    // 给进程着色输出 - 为每个项目分配固定颜色而不是随机颜色
    const projectColors = {
        // 可以根据项目名称分配固定颜色
    };

    // 使用项目名称的哈希值来确定颜色，这样同一个项目每次都是相同颜色
    const colors = ['\x1b[32m', '\x1b[33m', '\x1b[34m', '\x1b[35m', '\x1b[36m', '\x1b[90m', '\x1b[94m', '\x1b[96m'];
    const colorIndex = Math.abs(projectName.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)) % colors.length;
    const color = projectColors[projectName] || colors[colorIndex];

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

    process.stdout.on('data', (data) => {
        console.log(`${color}[${projectName}] ${data.toString().trim()}\x1b[0m`);
    });

    process.stderr.on('data', (data) => {
        const output = data.toString().trim();

        // 检查是否为编译信息而非真正的错误
        const isCompileInfo = compilePatterns.some(pattern => pattern.test(output));

        if (isCompileInfo) {
            // 使用与标准输出相同的颜色显示编译信息
            console.log(`${color}[${projectName}] ${output}\x1b[0m`);
        } else {
            // 真正的错误使用红色
            console.error(`\x1b[31m[${projectName} 错误] ${output}\x1b[0m`);
        }
    });

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

// 主函数
async function main() {
    const config = loadConfig();

    // 解析命令行参数
    const args = process.argv.slice( 2 );
    const command = args[0];

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

        console.log( `\n\x1b[1m正在并发启动平台 ${platformName} 的项目: ${projectsToStart.join( ', ' )}\x1b[0m\n` );

        // 并发启动所有项目
        const processes = [];

        // 创建所有项目的启动Promise
        const startPromises = projectsToStart.map(async (project, index) => {
            // 为每个项目添加一个小的延迟，避免同时启动导致的资源竞争
            await new Promise(resolve => setTimeout(resolve, index * 500)); // 每个项目延迟500ms

            console.log(`\x1b[36m[并发启动] 开始启动项目: ${project}\x1b[0m`);
            const proc = await startProject(project, config);

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
