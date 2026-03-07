/**
 * KnexFlow — Transaction flow visualization
 * Shows animated sender -> recipient diagram for send/receive blocks
 *
 * v2: Improved address display, hover effects, responsive layout,
 * clickable nodes to navigate to account view
 */
const KnexFlow = {
    init() {
        Explorer.on('block:detail', (block) => this.renderFlow(block));
    },

    renderFlow(block) {
        const container = document.getElementById('blockFlowContainer');
        if (!container) return;
        container.innerHTML = '';

        // Only show flow for send and receive blocks
        if (block.block_type !== 'send' && block.block_type !== 'receive') return;

        const diagram = document.createElement('div');
        diagram.className = 'flow-diagram';

        if (block.block_type === 'send') {
            this.renderSendFlow(diagram, block);
        } else if (block.block_type === 'receive') {
            this.renderReceiveFlow(diagram, block);
        }

        container.appendChild(diagram);
    },

    renderSendFlow(diagram, block) {
        const sender = block.account || '?';
        const senderShort = Explorer.truncateAddress(sender);
        const amount = Explorer.formatAmount(block.amount || block.balance || '0');

        // Determine destination
        let dest = '';
        let destShort = '?';
        if (block.destination && Explorer.isValidAddress(block.destination)) {
            dest = block.destination;
            destShort = Explorer.truncateAddress(dest);
        } else if (block.link && Explorer.isValidAddress(block.link)) {
            dest = block.link;
            destShort = Explorer.truncateAddress(dest);
        } else if (block.link) {
            dest = block.link;
            destShort = dest.slice(0, 8) + '...' + dest.slice(-6);
        }

        diagram.appendChild(this.createNode('Sender', senderShort, 'flow-sender', sender));
        diagram.appendChild(this.createArrow(amount));
        diagram.appendChild(this.createNode('Recipient', destShort, 'flow-receiver', dest));
    },

    renderReceiveFlow(diagram, block) {
        const receiver = block.account || '?';
        const receiverShort = Explorer.truncateAddress(receiver);
        const amount = Explorer.formatAmount(block.amount || block.balance || '0');
        const source = block.link || block.source || '?';
        const sourceShort = source.length > 16 ? source.slice(0, 8) + '...' + source.slice(-6) : source;

        diagram.appendChild(this.createNode('Source Block', sourceShort, 'flow-source', source));
        diagram.appendChild(this.createArrow(amount));
        diagram.appendChild(this.createNode('Receiver', receiverShort, 'flow-receiver', receiver));
    },

    createNode(label, addressText, className, fullAddress) {
        const node = document.createElement('div');
        node.className = `flow-node ${className}`;

        const labelEl = document.createElement('div');
        labelEl.className = 'flow-node-label';
        labelEl.textContent = label;

        const addrEl = document.createElement('div');
        addrEl.className = 'flow-node-addr';
        addrEl.textContent = addressText;
        addrEl.title = fullAddress;

        node.appendChild(labelEl);
        node.appendChild(addrEl);

        // Make clickable if valid address
        if (fullAddress && Explorer.isValidAddress(fullAddress)) {
            node.style.cursor = 'pointer';
            node.addEventListener('click', () => Explorer.lookupAccount(fullAddress));
        } else if (fullAddress && Explorer.isValidHash(fullAddress)) {
            node.style.cursor = 'pointer';
            node.addEventListener('click', () => Explorer.lookupBlock(fullAddress));
        }

        return node;
    },

    createArrow(amount) {
        const arrow = document.createElement('div');
        arrow.className = 'flow-arrow';

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'flow-arrow-svg');
        svg.setAttribute('viewBox', '0 0 200 40');
        svg.setAttribute('preserveAspectRatio', 'none');

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', '0');
        line.setAttribute('y1', '20');
        line.setAttribute('x2', '185');
        line.setAttribute('y2', '20');
        line.setAttribute('stroke', '#00ff00');
        line.setAttribute('stroke-width', '2');
        line.setAttribute('class', 'flow-line-anim');

        const arrowHead = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        arrowHead.setAttribute('points', '185,12 200,20 185,28');
        arrowHead.setAttribute('fill', '#00ff00');

        svg.appendChild(line);
        svg.appendChild(arrowHead);

        const amountEl = document.createElement('div');
        amountEl.className = 'flow-amount';
        amountEl.textContent = amount + ' KNEX';

        arrow.appendChild(svg);
        arrow.appendChild(amountEl);

        return arrow;
    },
};
