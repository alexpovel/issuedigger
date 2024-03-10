SHELL := /bin/bash

# https://github.com/gr2m/universal-github-app-jwt?tab=readme-ov-file#about-private-key-formats
pkcs8.pem: pkcs1.pem
	openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in $< -out $@

# https://www.reddit.com/r/commandline/comments/tfyrae/comment/i18uk63/
pretty-screenshot.png: screenshot.png
	tmpfile=$$(mktemp) && \
	width=$$(identify -format "%w" $<) && \
	height=$$(identify -format "%h" $<) && \
	echo $$width $$height && \
	convert -size "$$width"x"$$height" xc:none -draw "roundrectangle 0,0,"$$width","$$height",20,20" png:- | convert $< -matte - -compose DstIn -composite $$tmpfile && \
	convert $$tmpfile \( +clone -background black -shadow 100x30+0+0 \) +swap -bordercolor none -border 15 -background none -layers merge +repage $@
