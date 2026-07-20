#!/bin/bash
# Grok Build - 一键修复「已损坏」问题
# 双击运行即可

echo "========================================"
echo "  Grok Build - 一键修复工具"
echo "========================================"
echo ""

# 检查是否在dmg中
if [ -d "/Volumes/Grok Build/Grok Build.app" ]; then
    APP_PATH="/Volumes/Grok Build/Grok Build.app"
elif [ -d "./Grok Build.app" ]; then
    APP_PATH="./Grok Build.app"
elif [ -d "/Applications/Grok Build.app" ]; then
    APP_PATH="/Applications/Grok Build.app"
else
    echo "❌ 未找到 Grok Build.app"
    echo ""
    echo "请先将 Grok Build 拖到应用程序文件夹"
    echo "然后重新运行此脚本"
    echo ""
    read -p "按回车键退出..."
    exit 1
fi

echo "✅ 找到应用: $APP_PATH"
echo ""
echo "🔧 正在修复..."

# 移除隔离属性
xattr -cr "$APP_PATH"

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ 修复成功！"
    echo ""
    echo "现在可以正常打开 Grok Build 了"
    echo ""
    # 询问是否打开应用
    read -p "是否现在打开应用？(y/n): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        open "$APP_PATH"
    fi
else
    echo ""
    echo "❌ 修复失败，请尝试手动运行:"
    echo "xattr -cr \"$APP_PATH\""
fi

echo ""
read -p "按回车键退出..."
