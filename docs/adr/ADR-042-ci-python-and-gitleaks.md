# ADR-042：CI に Python（DIV-1）と gitleaks（秘密情報のオラクル）を足す

日付：2026-10-03（人間の決定 7）

## 決定

- DIV-1（Python の Diver で3分）のために、CI に `actions/setup-python` を足す。ブランチ `interop/std3-div1` の差分を了承した。
- gitleaks で git の履歴と作業ツリーの秘密情報が0件であることを確かめるオラクルを足す（docs/outbox/spec-v2-diff.md の B5）。REG-4（秘密鍵）は残し、gitleaks は API キーやトークンの形を受け持つ。
- どちらも、Action や道具は版をコミットの SHA（または検証済みのハッシュ）で固定する。

## 理由

spec §20.2 のローンチの条件に、「新しい環境で3回、3分以内」と「git の秘密情報が0件（gitleaks）」がある。

## 捨てた代替案

- **REG-4 だけで秘密情報を測る**：REG-4 は秘密鍵（JWK の `d`、PEM）しか見ない。

## 見直す条件

gitleaks の規則の誤検知が、許可リストで抑えられないほど増えた時。

## 出典

spec v2.0.1 §20.2。REG-4、DIV-1。
