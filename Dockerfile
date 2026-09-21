FROM apify/actor-node:20
WORKDIR /home/myuser
COPY package*.json ./
RUN npm --quiet set progress=false && npm install --omit=dev
COPY . ./
CMD ["npm", "start"]
