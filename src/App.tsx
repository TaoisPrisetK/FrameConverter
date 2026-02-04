import { useEffect, useMemo, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { open } from '@tauri-apps/plugin-dialog'
import { Play, Settings2, XCircle, CheckCircle2, Folder, Pause, Square } from 'lucide-react'
import { motion } from 'framer-motion'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'

type FrameFileInfo = {
  path: string
  width: number
  height: number
  size: number
}

type ScanResult = {
  files: FrameFileInfo[]
  total: number
  allSameSize: boolean
  baseSize: [number, number] | null
}

type ConvertProgressEvent = {
  phase: string
  current: number
  total: number
  percent: number
  format?: string | null
  file?: string | null
}

type ConvertResult = {
  format: string
  path: string
  success: boolean
  error?: string | null
  originalSize?: number | null
  compressedSize?: number | null
}

function getBaseName(path: string): string {
  const parts = path.split(/[/\\]/)
  const fileName = parts[parts.length - 1] || path
  // Remove extension and trailing sequence numbers (e.g., _0001, _001, _01, _1)
  return fileName
    .replace(/\.[^/.]+$/, '')  // Remove extension
    .replace(/[_-]\d+$/, '')   // Remove trailing sequence numbers like _0001, -001
}

export default function App() {
  const [inputPath, setInputPath] = useState<string>('')
  const [inputPaths, setInputPaths] = useState<string[]>([])
  const [isFolder, setIsFolder] = useState<boolean>(false)
  const [outputDir, setOutputDir] = useState<string>('')
  const [outputName, setOutputName] = useState<string>('')
  const [fps, setFps] = useState<string>('30')
  const [loopCount, setLoopCount] = useState<string>('0')
  const [formats, setFormats] = useState<string[]>(['apng'])
  const [useLocalCompression, setUseLocalCompression] = useState<boolean>(false)
  const [compressionQuality, setCompressionQuality] = useState<string>('0')
  const [isEditingCompression, setIsEditingCompression] = useState(false)
  const [tempCompressionValue, setTempCompressionValue] = useState<string>('0')

  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [isConverting, setIsConverting] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [progress, setProgress] = useState<ConvertProgressEvent | null>(null)
  const [results, setResults] = useState<ConvertResult[]>([])

  const containerRef = useRef<HTMLDivElement | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const dialogInFlightRef = useRef<{ input: boolean; inputFolder: boolean; outputDir: boolean }>({
    input: false,
    inputFolder: false,
    outputDir: false,
  })


  const [isPickingInput, setIsPickingInput] = useState(false)
  const [isPickingInputFolder, setIsPickingInputFolder] = useState(false)
  const [isPickingOutputDir, setIsPickingOutputDir] = useState(false)
  const dialogReqIdRef = useRef<{ input: number; inputFolder: number; outputDir: number }>({
    input: 0,
    inputFolder: 0,
    outputDir: 0,
  })

  const canConvert = useMemo(() => {
    if (isConverting) return false
    if (isFolder) {
      if (!inputPath.trim()) return false
    } else {
      if (!(inputPaths.length || inputPath.trim())) return false
    }
    if (!outputDir.trim()) return false
    if (formats.length === 0) return false
    const fpsNum = Number(fps)
    if (!Number.isFinite(fpsNum) || fpsNum <= 0) return false
    const loopNum = Number(loopCount)
    if (!Number.isFinite(loopNum) || loopNum < 0) return false
    return true
  }, [isConverting, isFolder, inputPath, inputPaths, outputDir, formats, fps, loopCount])

  async function scanFiles(overrideInputPath?: string, overrideInputPaths?: string[], overrideIsFolder?: boolean) {
    const currentInputPath = overrideInputPath !== undefined ? overrideInputPath : inputPath
    const currentInputPaths = overrideInputPaths !== undefined ? overrideInputPaths : inputPaths
    const currentIsFolder = overrideIsFolder !== undefined ? overrideIsFolder : isFolder
    
    if (currentIsFolder && !currentInputPath.trim()) return
    if (!currentIsFolder && !currentInputPaths.length && !currentInputPath.trim()) return

    try {
      const result = await invoke<ScanResult>('scan_frame_files', {
        inputMode: currentIsFolder ? 'folder' : 'file',
        inputPath: currentInputPath,
        inputPaths: !currentIsFolder ? currentInputPaths : null,
      })
      setScanResult(result)
    } catch (error) {
      console.error('Scan error:', error)
    }
  }

  async function pickInput() {
    try {
      if (dialogInFlightRef.current.input) return
      dialogInFlightRef.current.input = true
      setIsPickingInput(true)
      const reqId = ++dialogReqIdRef.current.input

      // Focus window first to ensure dialog is visible
      try {
        await getCurrentWindow().setFocus()
      } catch {
        // Ignore focus errors
      }

      // Open file dialog (supports multiple files)
      const picked = await open({
        directory: false,
        multiple: true,
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'apng'] }],
      })
      if (reqId !== dialogReqIdRef.current.input) return

      // If user selected files
      if (picked) {
        const filesRaw = Array.isArray(picked)
          ? picked.filter((x): x is string => typeof x === 'string')
          : typeof picked === 'string'
            ? [picked]
            : []
        const files = Array.from(new Set(filesRaw))
        if (files.length > 0) {
          setInputPaths(files)
          setInputPath(files[0] ?? '')
          setIsFolder(false)
          await scanFiles(files[0] ?? '', files, false)
          return
        }
      }
    } catch (error) {
      console.error('Error picking input:', error)
    } finally {
      dialogInFlightRef.current.input = false
      setIsPickingInput(false)
    }
  }

  async function pickInputFolder() {
    try {
      if (dialogInFlightRef.current.inputFolder) return
      dialogInFlightRef.current.inputFolder = true
      setIsPickingInputFolder(true)
      const reqId = ++dialogReqIdRef.current.inputFolder

      const folderPicked = await open({
        directory: true,
        multiple: false,
      })
      if (reqId !== dialogReqIdRef.current.inputFolder) return

      if (folderPicked) {
        const p = typeof folderPicked === 'string' ? folderPicked : ''
        if (p) {
          setInputPath(p)
          setInputPaths([])
          setIsFolder(true)
          await scanFiles(p, [], true)
        }
      }
    } catch (error) {
      console.error('Error picking folder:', error)
    } finally {
      dialogInFlightRef.current.inputFolder = false
      setIsPickingInputFolder(false)
    }
  }

  async function pickOutputDir() {
    try {
      if (dialogInFlightRef.current.outputDir) return
      dialogInFlightRef.current.outputDir = true
      setIsPickingOutputDir(true)
      const reqId = ++dialogReqIdRef.current.outputDir
      const picked = await open({ directory: true, multiple: false })
      if (reqId !== dialogReqIdRef.current.outputDir) return
      const p = typeof picked === 'string' ? picked : ''
      setOutputDir(p)
    } finally {
      dialogInFlightRef.current.outputDir = false
      setIsPickingOutputDir(false)
    }
  }

  function resetDialogs() {
    dialogInFlightRef.current = { input: false, inputFolder: false, outputDir: false }
    dialogReqIdRef.current.input += 1
    dialogReqIdRef.current.inputFolder += 1
    dialogReqIdRef.current.outputDir += 1
    setIsPickingInput(false)
    setIsPickingInputFolder(false)
    setIsPickingOutputDir(false)
  }

  async function togglePause() {
    if (isPaused) {
      await invoke('resume_conversion')
      setIsPaused(false)
    } else {
      await invoke('pause_conversion')
      setIsPaused(true)
    }
  }

  async function cancelConvert() {
    await invoke('cancel_conversion')
    setIsConverting(false)
    setIsPaused(false)
    setProgress(null)
  }

  async function startConvert() {
    if (!canConvert) {
      return
    }
    setIsConverting(true)
    setIsPaused(false)
    setProgress(null)
    setResults([])

    try {
      const convertResults = await invoke<ConvertResult[]>('convert_sequence_frames', {
        request: {
          inputMode: isFolder ? 'folder' : 'file',
          inputPath,
          inputPaths: !isFolder ? inputPaths : null,
          outputDir: outputDir.trim(),
          outputName: outputName.trim() || null,
          fps: Number(fps),
          loopCount: Number(loopCount),
          formats,
          useLocalCompression,
          compressionQuality: Number(compressionQuality),
        }
      })
      setResults(convertResults)
    } catch (error) {
      console.error('Convert error:', error)
    } finally {
      setIsConverting(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    const unsubs: Array<() => void> = []
    ;(async () => {
      const u1 = await listen<ConvertProgressEvent>('convert-progress', (e) => setProgress(e.payload))
      if (cancelled) {
        u1()
        return
      }
      unsubs.push(u1)
    })()
    return () => {
      cancelled = true
      for (const u of unsubs) u()
    }
  }, [])

  // Auto-generate output name when scanResult changes
  useEffect(() => {
    if (scanResult && scanResult.baseSize) {
      const baseName = isFolder
        ? getBaseName(inputPath)
        : getBaseName(inputPaths[0] || inputPath)
      const newOutputName = `${baseName}_${scanResult.baseSize[0]}x${scanResult.baseSize[1]}`
      setOutputName(newOutputName)
    }
  }, [scanResult, isFolder, inputPath, inputPaths])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onMouseDown = async (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (!t) return
      if (t.closest('button, input, textarea, a, [data-tauri-drag-region="false"]')) return
      try {
        await getCurrentWindow().startDragging()
      } catch {
        // ignore
      }
    }
    el.addEventListener('mousedown', onMouseDown)
    return () => el.removeEventListener('mousedown', onMouseDown)
  }, [])

  // debug instrumentation removed

  const toggleFormat = (format: string) => {
    setFormats((prev) =>
      prev.includes(format) ? prev.filter((f) => f !== format) : [...prev, format]
    )
  }

  const highlightColor = '#55B2F9'
  const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1]

  const fadeUp = {
    initial: { opacity: 0, y: 36 },
    animate: { opacity: 1, y: 0, transition: { duration: 0.9, ease: EASE_OUT } },
  }
  const fadeUpOpaque = {
    initial: { opacity: 1, y: 0 },
    animate: { opacity: 1, y: 0, transition: { duration: 0.9, ease: EASE_OUT } },
  }


  return (
    <div
      ref={containerRef}
      className="relative h-full w-full text-black theme-light"
      style={{
        background: '#ffffff',
      }}
      data-theme="light"
    >
      {/* Background patterns */}
      <>
        <div
          className="pointer-events-none absolute inset-0 z-0"
          style={{
            background:
              'radial-gradient(900px circle at 20% 15%, rgba(0,0,0,0.12) 0%, transparent 55%), radial-gradient(1100px circle at 85% 85%, rgba(0,0,0,0.1) 0%, transparent 60%)',
          }}
        />
        <div
          className="pointer-events-none absolute inset-0 z-0"
          style={{
            backgroundImage: `
              linear-gradient(rgba(0,0,0,0.03) 1px, transparent 1px),
              linear-gradient(90deg, rgba(0,0,0,0.03) 1px, transparent 1px)
            `,
            backgroundSize: '120px 120px',
          }}
        />
        <div
          className="pointer-events-none absolute inset-0 z-0"
          style={{
            backgroundImage: `
              linear-gradient(45deg, rgba(0,0,0,0.015) 25%, transparent 25%),
              linear-gradient(-45deg, rgba(0,0,0,0.015) 25%, transparent 25%),
              linear-gradient(45deg, transparent 75%, rgba(0,0,0,0.015) 75%),
              linear-gradient(-45deg, transparent 75%, rgba(0,0,0,0.015) 75%)
            `,
            backgroundSize: '240px 240px',
            backgroundPosition: '0 0, 0 120px, 120px -120px, -120px 0px',
          }}
        />
        {/* Corner fade - hide grid in top-left and bottom-right (light) */}
        <div
          className="pointer-events-none absolute inset-0 z-0"
          style={{
            background: `
              radial-gradient(ellipse 80% 70% at 0% 0%, rgba(255,255,255,1) 0%, rgba(255,255,255,0) 60%),
              radial-gradient(ellipse 80% 70% at 100% 100%, rgba(255,255,255,1) 0%, rgba(255,255,255,0) 60%)
            `,
          }}
        />
        {/* Bottom fade - hide grid near bottom (light) */}
        <div
          className="pointer-events-none absolute inset-0 z-0"
          style={{
            background: 'radial-gradient(ellipse 90% 60% at 50% 100%, rgba(255,255,255,1) 0%, rgba(255,255,255,0) 60%)',
          }}
        />
        {/* Subtle warm glow top-left (light) */}
        <div
          className="pointer-events-none absolute inset-0 z-0"
          style={{
            background: 'radial-gradient(600px ellipse at 15% 10%, rgba(240,200,140,0.12) 0%, transparent 50%)',
          }}
        />
      </>
      {/* Light mode noise overlay */}
      <div
        ref={overlayRef}
        className="pointer-events-none absolute inset-0"
        style={{
          opacity: 0.18,
          backgroundImage: 'url("data:image/svg+xml;utf8,<svg xmlns=%27http://www.w3.org/2000/svg%27 width=%271.5%27 height=%271.5%27 viewBox=%270 0 1.5 1.5%27><circle cx=%270.75%27 cy=%270.75%27 r=%270.28%27 fill=%27%23ffffff%27 opacity=%270.07%27/></svg>")',
          backgroundSize: '1.5px 1.5px',
        }}
      />
      <div className="relative z-10 mx-auto h-full w-full max-w-[1000px] overflow-y-auto px-[44px] pt-[72px] pb-5 no-scrollbar">
        <div className="flex min-h-full flex-col gap-5">
          <motion.div {...fadeUp} className="flex items-start justify-between">
            <div>
              <div className="text-5xl font-black tracking-tight bg-gradient-to-r from-[#55B2F9] via-[#1E4F9E] to-[#55B2F9] bg-clip-text text-transparent">
                FrameConverter
              </div>
              <div className="mt-1 text-sm muted-copy">
                Convert image sequences to animated WebP, APNG, or GIF
              </div>
            </div>
            <div />
          </motion.div>

          <motion.div
            {...fadeUpOpaque}
            className="mt-5 grid w-full flex-1 min-h-0 grid-cols-1 items-stretch gap-5 md:grid-cols-[1.3fr_0.7fr]"
            style={{ height: 'calc(100% - 10px)' }}
          >
            <Card
              className="flex flex-col h-full"
              style={{ height: '460px' }}
              logId="paths-card"
            >
              <CardHeader className="pb-[6px]">
                <CardTitle className="flex items-center gap-2">
                  <Settings2 className="h-5 w-5 opacity-70" />
                  Paths
                </CardTitle>
                <div
                  className="mt-12 h-px bg-black/[0.03]"
                  style={{ marginTop: '20px' }}
                />
              </CardHeader>
              <CardContent className="flex-1 space-y-7 !pb-3 mt-[10px]">
                <div className="space-y-2">
                  <div className="text-sm font-semibold">Input</div>
                  <div className="flex items-center gap-3">
                    <Input
                      value={inputPath}
                      onChange={(e) => {
                        const v = e.target.value
                        setInputPath(v)
                        if (!isFolder) setInputPaths(v.trim() ? [v] : [])
                        setScanResult(null)
                      }}
                      placeholder="/path/to/files or /path/to/folder"
                    />
                    <div className="flex gap-2">
                      <Button variant="outline" className="h-10" onClick={pickInput} disabled={isPickingInput}>
                        {isPickingInput ? 'Opening…' : 'Browse Files'}
                      </Button>
                      <Button variant="outline" className="h-10" onClick={pickInputFolder} disabled={isPickingInputFolder}>
                        <Folder className="h-4 w-4" />
                        {isPickingInputFolder ? 'Opening…' : 'Browse Folder'}
                      </Button>
                    </div>
                  </div>
                  {(isPickingInput || isPickingInputFolder || isPickingOutputDir) && (
                  <div className="text-xs muted-copy">
                      Dialog seems stuck?{' '}
                      <button
                        type="button"
                        className="underline underline-offset-4 hover:text-white/80"
                        onClick={resetDialogs}
                      >
                        Reset
                      </button>
                    </div>
                  )}
                  {scanResult && (
                    <div className="text-xs muted-copy">
                      Found: <span style={{ color: highlightColor }} className="font-semibold">{scanResult.total}</span> files
                      {scanResult.baseSize && (
                        <span className="ml-2 muted-copy">
                          ({scanResult.baseSize[0]}×{scanResult.baseSize[1]})
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-semibold">Output Directory</div>
                  <div className="flex items-center gap-3">
                    <Input
                      value={outputDir}
                      onChange={(e) => setOutputDir(e.target.value)}
                      placeholder="/path/to/output"
                    />
                    <Button variant="outline" className="h-10" onClick={pickOutputDir} disabled={isPickingOutputDir}>
                      {isPickingOutputDir ? 'Opening…' : 'Browse'}
                    </Button>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-sm font-semibold">Output Name (optional)</div>
                  <Input
                    value={outputName}
                    onChange={(e) => setOutputName(e.target.value)}
                    placeholder="Auto-generated from input name + size"
                  />
                </div>
              </CardContent>
            </Card>

            <Card
              className="flex flex-col h-full"
              style={{ height: '460px' }}
              logId="settings-card"
            >
              <CardHeader className="pb-[6px]">
                <CardTitle className="flex items-center gap-2">
                  <Settings2 className="h-5 w-5 opacity-70" />
                  Settings
                </CardTitle>
                <div
                  className="mt-12 h-px bg-black/[0.03]"
                  style={{ marginTop: '20px' }}
                />
              </CardHeader>
              <CardContent className="flex-1 space-y-7 !pb-3 mt-[10px]">
                <div className="space-y-2">
                  <div className="text-sm font-semibold">Frame Rate</div>
                  <Input
                    value={fps}
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^0-9.]/g, '')
                      setFps(v)
                    }}
                    placeholder="30"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold">Loop Count</div>
                    <div className="text-xs font-normal muted-copy">0 = Infinite Loop</div>
                  </div>
                  <Input
                    value={loopCount}
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^0-9]/g, '')
                      setLoopCount(v)
                    }}
                    placeholder="0"
                  />
                </div>

                <div className="space-y-3.5">
                  <div className="text-sm font-semibold">Output Formats</div>
                  <div className="flex gap-6">
                    {['apng', 'webp', 'gif'].map((format) => (
                      <div key={format} className="flex items-center space-x-2">
                        <Checkbox
                          id={format}
                          checked={formats.includes(format)}
                          onCheckedChange={() => toggleFormat(format)}
                        />
                        <Label htmlFor={format} className="cursor-pointer">
                          {format.toUpperCase()}
                        </Label>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-2" style={{ marginTop: '42px' }}>
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold">Compression</div>
                    <div className="text-xs font-normal muted-copy">Higher = Better Quality</div>
                  </div>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={compressionQuality || '0'}
                      onChange={(e) => {
                        const num = Number(e.target.value)
                        setCompressionQuality(num.toString())
                      }}
                      className="flex-1 h-2 bg-black/25 rounded-lg appearance-none cursor-pointer accent-[#55B2F9]"
                      style={{
                        background: `linear-gradient(to right, #55B2F9 0%, #55B2F9 ${(Number(compressionQuality || 0) / 100) * 100}%, rgba(0,0,0,0.25) ${(Number(compressionQuality || 0) / 100) * 100}%, rgba(0,0,0,0.25) 100%)`
                      }}
                    />
                    {isEditingCompression ? (
                      <Input
                        value={tempCompressionValue}
                        onChange={(e) => {
                          const v = e.target.value.replace(/[^0-9]/g, '')
                          if (v === '' || (Number(v) >= 0 && Number(v) <= 100)) {
                            setTempCompressionValue(v)
                          }
                        }}
                        onBlur={() => {
                          const num = Number(tempCompressionValue)
                          if (num >= 0 && num <= 100) {
                            setCompressionQuality(num === 0 ? '0' : num.toString())
                          } else {
                            setTempCompressionValue(compressionQuality)
                          }
                          setIsEditingCompression(false)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const num = Number(tempCompressionValue)
                            if (num >= 0 && num <= 100) {
                              setCompressionQuality(num === 0 ? '0' : num.toString())
                            } else {
                              setTempCompressionValue(compressionQuality)
                            }
                            setIsEditingCompression(false)
                          } else if (e.key === 'Escape') {
                            setTempCompressionValue(compressionQuality)
                            setIsEditingCompression(false)
                          }
                        }}
                        className="w-12 h-8 text-sm text-right px-2"
                        autoFocus
                      />
                    ) : (
                      <div
                        className="text-sm font-medium w-12 h-8 flex items-center justify-end cursor-text select-none"
                        onClick={() => {
                          setTempCompressionValue(compressionQuality)
                          setIsEditingCompression(true)
                        }}
                      >
                        {compressionQuality === '0' ? 'Off' : compressionQuality}
                      </div>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>

          <div style={{ transform: 'translateY(0px)' }}>
            <motion.div {...fadeUpOpaque} className="mb-8 w-full space-y-2" style={{ isolation: 'isolate' }}>
              <div className={canConvert ? 'cta-pill-wrap w-full' : 'w-full'}>
                {canConvert ? (
                  <button
                    className="cta-plain cta-pill transition-opacity"
                    disabled={!canConvert}
                    onClick={startConvert}
                    type="button"
                  >
                    <Play className="h-5 w-5" />
                    {isConverting ? 'Converting...' : 'Convert'}
                  </button>
                ) : (
                  <Button
                    className="h-16 w-full text-lg font-semibold border-0 !opacity-100 rounded-[10px] !bg-[#e5e7eb] text-black/40 hover:!bg-[#e5e7eb]"
                    disabled
                  >
                    <Play className="h-5 w-5" />
                    Convert
                  </Button>
                )}
              </div>

              {isConverting && (
                <div className="p-2 text-sm space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {!isPaused && <div className="h-4 w-4 border-2 border-white/30 border-t-[#55B2F9] rounded-full animate-spin" />}
                    {isPaused && <Pause className="h-4 w-4 text-yellow-500" />}
                    <span className="font-semibold">
                      {isPaused ? 'Paused' : (progress ? progress.phase : 'Starting conversion...')}
                      {progress?.format && <span className="ml-2 text-white/12">({progress.format})</span>}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={togglePause}
                      className="px-3 py-1 rounded bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 text-xs font-medium transition-colors"
                    >
                      {isPaused ? <><Play className="h-3 w-3 inline mr-1" />Resume</> : <><Pause className="h-3 w-3 inline mr-1" />Pause</>}
                    </button>
                    <button
                      onClick={cancelConvert}
                      className="px-3 py-1 rounded bg-red-500/20 hover:bg-red-500/30 text-red-400 text-xs font-medium transition-colors"
                    >
                      <Square className="h-3 w-3 inline mr-1" />Cancel
                    </button>
                  </div>
                </div>
                {progress && (
                  <div className="space-y-1">
                    <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-[#55B2F9] transition-all duration-100"
                        style={{ width: `${Math.min(progress.percent || 0, 100)}%` }}
                      />
                    </div>
                    <div className="text-xs text-white/12 text-right">
                      <span className="text-white/80 font-medium">{Math.round(progress.percent || 0)}%</span>
                      {progress.total > 0 && <span className="ml-2">({progress.current} / {progress.total})</span>}
                    </div>
                  </div>
                )}
              </div>
            )}

            {results.length > 0 && (
              <div className="space-y-2">
                <div className="text-sm font-semibold">Results:</div>
                {results.map((result, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between rounded-md p-3 text-sm bg-white/90"
                  >
                    <div className="flex items-center gap-2">
                      {result.success ? (
                        <CheckCircle2 className="h-4 w-4 text-green-500" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-500" />
                      )}
                      <span className="font-semibold">{result.format.toUpperCase()}</span>
                      <span className="text-white/20 truncate">{result.path}</span>
                    </div>
                    {result.success && result.originalSize && (
                      <div className="text-xs text-white/12">
                        {result.compressedSize ? (
                          <>
                            {((result.compressedSize / result.originalSize) * 100).toFixed(1)}% of original
                          </>
                        ) : (
                          <>{(result.originalSize / 1024).toFixed(1)} KB</>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                </div>
              )}
            </motion.div>
          </div>
        </div>
      </div>
    </div>
  )
}
