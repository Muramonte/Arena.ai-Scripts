// ==UserScript==
// @name         Arena.ai Force Unlock
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Adds a button to force unlock frozen chat inputs on Arena.ai
// @author       You
// @match        https://arena.lmsys.org/*
// @match        https://chat.lmsys.org/*
// @match        https://arena.ai/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // Create the Panic Button
    const btn = document.createElement("button");
    btn.innerHTML = "🔓 UNLOCK UI";
    btn.style.position = "fixed";
    btn.style.bottom = "10px";
    btn.style.right = "10px";
    btn.style.zIndex = "9999";
    btn.style.padding = "10px 20px";
    btn.style.backgroundColor = "DarkCyan";
    btn.style.color = "white";
    btn.style.fontWeight = "bold";
    btn.style.border = "none";
    btn.style.borderRadius = "5px";
    btn.style.cursor = "pointer";

    document.body.appendChild(btn);

    // The Unlock Logic
    btn.addEventListener("click", function() {
        // Unlock Textarea
        const input = document.querySelector('textarea');
        if(input) input.removeAttribute('disabled');

        // Unlock Buttons (Remove 'pointer-events-none' which is the main culprit)
        document.querySelectorAll('button').forEach(b => {
            b.removeAttribute('disabled');
            b.classList.remove('pointer-events-none', 'cursor-not-allowed', 'opacity-50');
        });

        alert("Locks removed! Try sending now.");
    });
})();