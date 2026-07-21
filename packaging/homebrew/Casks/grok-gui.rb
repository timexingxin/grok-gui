# frozen_string_literal: true

cask "grok-gui" do
  version "0.1.0"
  sha256 arm:   "190ed74c269af285fecce30ac9f3d1d183ccb1cc5748f1439bbe25590a74af40",
         intel: "386fbdbf947c390dc5fe6c7544c2b755add98b38ec1c33854cbbaa1a1b1a5f7d"

  url "https://github.com/timexingxin/grok-gui/releases/download/v#{version}/Grok-GUI-#{version}-Electron-#{arch}.dmg"
  name "Grok GUI"
  desc "Full-featured desktop wrapper for Grok"
  homepage "https://github.com/timexingxin/grok-gui"

  livecheck do
    url :url
    strategy :github_latest_release
  end

  depends_on macos: ">= :big_sur"

  app "Grok GUI.app"

  zap trash: [
    "~/Library/Application Support/com.grok-gui.desktop",
    "~/Library/Caches/com.grok-gui.desktop",
    "~/Library/Preferences/com.grok-gui.desktop.plist",
    "~/Library/Saved Application State/com.grok-gui.desktop.savedState",
    "~/Library/WebKit/com.grok-gui.desktop",
  ]
end
