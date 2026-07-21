# frozen_string_literal: true

cask "grok-gui" do
  version "0.1.0"
  sha256 arm:   "9d10376d024a0a6c3feb475d9d77590ec38acb7ee93cfff9f502beb34e4f7b96",
         intel: "82d573206cebb7dfbc96d8bbcd874a19a3b0db8a01ffac37a00d114e7ceedc27"

  url "https://github.com/timexingxin/grok-gui/releases/download/v#{version}/Grok-GUI-#{version}-Electron-#{arch}.dmg"
  name "Grok GUI"
  desc "Full-featured desktop wrapper for Grok"
  homepage "https://github.com/timexingxin/grok-gui"

  livecheck do
    url :url
    strategy :github_latest_release
  end

  depends_on macos: :big_sur

  app "Grok GUI.app"

  zap trash: [
    "~/Library/Application Support/com.grok-gui.desktop",
    "~/Library/Caches/com.grok-gui.desktop",
    "~/Library/Preferences/com.grok-gui.desktop.plist",
    "~/Library/Saved Application State/com.grok-gui.desktop.savedState",
    "~/Library/WebKit/com.grok-gui.desktop",
  ]
end
