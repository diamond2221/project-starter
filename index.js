#!/usr/bin/env node

const { spawn } = require( 'child_process' );
const path = require( 'path' );
const fs = require( 'fs' );
const readline = require( 'readline' );
const os = require( 'os' );

// 配置文件路径
const CONFIG_FILE = path.join( os.homedir(), '.project-launcher.json' );

// 默认配置
const defaultConfig = {

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
function startProject( projectName, config ) {
    const projectConfig = config.projects[projectName];

    if ( !projectConfig ) {
        console.log( `\x1b[31m[错误] 未找到项目配置: ${projectName}\x1b[0m` );
        return null;
    }

    const projectPath = projectConfig.path;

    // 检查项目路径是否存在
    if ( !fs.existsSync( projectPath ) ) {
        console.log( `\x1b[31m[错误] 项目路径不存在: ${projectPath}\x1b[0m` );
        return null;
    }

    const command = projectConfig.command;
    console.log( `\x1b[36m[启动] ${projectName}: ${command} (路径: ${projectPath})\x1b[0m` );

    // 将命令拆分为主命令和参数
    const [cmd, ...args] = command.split( ' ' );

    // 使用 spawn 启动项目并保持输出流
    const process = spawn( cmd, args, {
        cwd: projectPath,
        stdio: 'pipe',
        shell: true
    } );

    // 给进程着色输出
    const colors = ['\x1b[32m', '\x1b[33m', '\x1b[34m', '\x1b[35m', '\x1b[36m'];
    const color = colors[Math.floor( Math.random() * colors.length )];

    process.stdout.on( 'data', ( data ) => {
        console.log( `${color}[${projectName}] ${data.toString().trim()}\x1b[0m` );
    } );

    process.stderr.on( 'data', ( data ) => {
        console.error( `\x1b[31m[${projectName} 错误] ${data.toString().trim()}\x1b[0m` );
    } );

    process.on( 'close', ( code ) => {
        if ( code !== 0 ) {
            console.log( `\x1b[31m[${projectName}] 进程退出，退出码 ${code}\x1b[0m` );
        }
    } );

    return process;
}

// 添加新项目配置
async function addProject( rl, config ) {
    console.log( '\n\x1b[1m添加新项目\x1b[0m' );

    const name = await question( rl, '项目名称: ' );
    const path = await question( rl, '项目路径: ' );
    const command = await question( rl, '启动命令 (默认: npm run serve): ' ) || 'npm run serve';

    config.projects[name] = { path, command };

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

        console.log( `\n\x1b[1m正在启动平台 ${platformName} 的项目: ${projectsToStart.join( ', ' )}\x1b[0m\n` );

        // 启动所有项目
        const processes = [];
        for ( const project of projectsToStart ) {
            const proc = startProject( project, config );
            if ( proc ) processes.push( proc );

            // 稍微延迟启动下一个项目，避免端口冲突等问题
            await new Promise( resolve => setTimeout( resolve, 2000 ) );
        }

        if ( processes.length === 0 ) {
            console.log( '\x1b[33m[警告] 没有启动任何项目\x1b[0m' );
            return;
        }

        console.log( `\n\x1b[32m成功启动 ${processes.length} 个项目\x1b[0m` );
        console.log( '\x1b[33m按 Ctrl+C 可以关闭所有项目\x1b[0m' );

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
async function configMode( rl, config ) {
    console.log( '\n\x1b[1m配置模式\x1b[0m' );
    console.log( '1. 添加新项目' );
    console.log( '2. 管理平台' );
    console.log( '0. 退出' );

    const choice = await question( rl, '请选择操作: ' );

    switch ( choice ) {
        case '1':
            await addProject( rl, config );
            await configMode( rl, config );
            break;
        case '2':
            await managePlatforms( rl, config );
            await configMode( rl, config );
            break;
        case '0':
            rl.close();
            break;
        default:
            console.log( '\x1b[31m[错误] 无效选择\x1b[0m' );
            await configMode( rl, config );
    }
}

main().catch( err => {
    console.error( '\x1b[31m[错误]', err, '\x1b[0m' );
    process.exit( 1 );
} );
